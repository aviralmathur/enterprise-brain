// The invoke gateway. D13: this is the ONLY enforcement that counts.
// Every access decision is re-evaluated here on every call; the client is never
// trusted to have already checked. Also the only write path up (D8).
import { newOutput } from '../brain/schema.mjs';

export class Gateway {
  constructor({ registry, grants, ledger, identity, audit, connectors, limits = {} }) {
    this.registry = registry;
    this.grants = grants;
    this.ledger = ledger;
    this.identity = identity;
    this.audit = audit;
    this.connectors = connectors ?? {};
    this.limits = { in_flight: 4, ...limits };
    this.calls = [];       // timestamps per agent, for rate limiting
    this.inFlight = 0;     // for load shedding
  }

  refuse(ctx, reason) {
    this.audit.record({
      action: 'invoke', employee: ctx.employee, via: ctx.via,
      target: ctx.target, outcome: 'refused', reason,
    });
    return { ok: false, reason };
  }

  onAccessList(agentId, employeeId) {
    const list = this.registry.accessList(agentId);
    if (list === 'org') return true;
    return Array.isArray(list) && list.includes(employeeId);
  }

  // What a fleet may see about an enterprise agent before it calls one. Consume
  // and invoke are reported separately because they are governed separately: an
  // access list opens the first, a live grant opens the second.
  catalogFor(employee, via) {
    return this.registry
      .all()
      .filter((a) => a.lifecycle !== 'retired')
      .map((a) => {
        const list = this.registry.accessList(a.id);
        const onList = list === 'org' || (Array.isArray(list) && list.includes(employee));
        const grant = via ? this.grants.find({ employee, via, agent: a.id }) : null;
        const system = a.connectors?.[0]?.system;
        const connector = this.connectors[system];
        return {
          id: a.id,
          dri: a.dri,
          produces: a.produces,
          cadence: a.cadence,
          connectors: (a.connectors ?? []).map((c) => `${c.system} (${c.auth_mode})`),
          invocable: Boolean(a.invocable),
          employee_reachable: a.employee_reachable !== false,
          on_access_list: onList,
          consume: onList ? 'open' : 'needs access',
          invoke: !a.invocable
            ? 'not invocable'
            : grant
              ? `granted until ${grant.expires_at.slice(0, 10)}`
              : 'needs a grant',
          rate_limit: a.rate_limit?.per_minute ?? null,
          ops: { reads: connector?.reads ?? [], writes: connector?.writes ?? [] },
        };
      });
  }

  withinRate(agentId) {
    const limit = this.registry.rateLimit(agentId);
    if (!limit) return false;
    const cutoff = Date.now() - 60_000;
    this.calls = this.calls.filter((c) => c.at > cutoff);
    return this.calls.filter((c) => c.agent === agentId).length < limit;
  }

  // The full authoritative check, in the order a reviewer will ask about it.
  authorize({ employee, via, target }) {
    const ctx = { employee, via, target };

    const who = this.identity.resolve(employee);
    if (who.status !== 'active') return { ...this.refuse(ctx, `employee ${employee} is not active`), stage: 'identity' };

    if (!this.registry.isInvocable(target)) return { ...this.refuse(ctx, `${target} is not invocable`), stage: 'registry' };

    // Term 1 of the access rule
    if (!this.onAccessList(target, employee)) {
      return { ...this.refuse(ctx, `employee ${employee} is not on the access list for ${target}`), stage: 'access_list' };
    }

    // Term 2 of the access rule
    const grant = this.grants.find({ employee, via, agent: target });
    if (!grant) {
      return { ...this.refuse(ctx, `no live grant for ${via ? `${via.fleet}/${via.agent}` : employee} on ${target}`), stage: 'grant' };
    }

    if (!this.withinRate(target)) {
      return { ...this.refuse(ctx, `rate limit exceeded for ${target}`), stage: 'rate_limit' };
    }

    if (this.inFlight >= this.limits.in_flight) {
      return { ...this.refuse(ctx, 'shed: gateway at capacity, retry later'), stage: 'load_shed' };
    }

    return { ok: true, grant };
  }

  // A vendor write always terminates at a human approval (Phase 5 exit test).
  // This also breaks the injection chain: hostile content -> agent -> vendor write.
  invoke({ employee, via, target, op, args = {}, approval = null }) {
    const ctx = { employee, via, target };
    const auth = this.authorize(ctx);
    if (!auth.ok) return auth;

    const agent = this.registry.get(target);
    const connector = this.connectors[agent.connectors?.[0]?.system];
    const isWrite = connector?.writes?.includes(op) ?? false;

    if (isWrite && !approval?.approved_by) {
      return {
        ...this.refuse(ctx, `write op "${op}" requires human approval`),
        stage: 'approval_required',
        needs_approval: { employee, target, op, args },
      };
    }

    this.calls.push({ agent: target, at: Date.now() });
    this.inFlight += 1;
    try {
      const result = connector
        ? connector.call(op, args, { employee })
        : { ok: false, reason: `no connector wired for ${target}` };

      this.audit.record({
        action: 'invoke', employee, via, target, outcome: 'allowed',
        detail: { op, write: isWrite, approved_by: approval?.approved_by ?? null, grant: auth.grant.id },
      });

      // Vendor results become typed outputs, normalised by the adapter, and the
      // ledger - not the adapter - decides their scope.
      if (result.ok && result.output) {
        const pub = this.ledger.publish(newOutput({
          ...result.output,
          producer: { fleet: 'enterprise', agent: target, identity: agent.dri },
        }));
        return { ok: true, result, published: pub.ok ? pub.output.id : null, scope_basis: pub.scope_basis };
      }
      return { ok: true, result };
    } finally {
      this.inFlight -= 1;
    }
  }
}
