// The consume path. Two checks, both of which must hold (D5 + D7):
//   employee is on the producing agent's access list
//   employee is inside the output's computed scope
// Answers cite provenance and status. Conflicts are surfaced, never resolved.
import { visibleTo, describe } from './scope.mjs';
import { freshness } from './schema.mjs';

export class Query {
  // resolvers: { accessList(agentId) -> 'org' | [ids], fleetOwner(fleetId) }
  constructor(ledger, { identity, audit, resolvers }) {
    this.ledger = ledger;
    this.identity = identity;
    this.audit = audit;
    this.resolvers = {
      accessList: () => [],
      fleetOwner: () => null,
      isEnterpriseAgent: () => false,
      ...resolvers,
    };
  }

  #onAccessList(agentId, employeeId) {
    const list = this.resolvers.accessList(agentId);
    if (list === 'org') return true;
    return Array.isArray(list) && list.includes(employeeId);
  }

  canConsume(employeeId, output) {
    const who = this.identity.resolve(employeeId);
    if (who.status !== 'active') return { ok: false, reason: `employee ${employeeId} is not active` };

    // D5 makes the AGENT the unit of access control - but only for enterprise
    // agents, which are the ones with a reviewed manifest and an access list.
    // An output published by an employee's fleet is governed by its scope alone,
    // which is fleet-private unless the gate widened it.
    if (this.resolvers.isEnterpriseAgent(output.producer.agent)
        && !this.#onAccessList(output.producer.agent, employeeId)) {
      return { ok: false, reason: `not on the access list for ${output.producer.agent}` };
    }
    if (!visibleTo(output.scope, employeeId, this.resolvers.fleetOwner)) {
      return { ok: false, reason: `outside the output's scope (${describe(output.scope)})` };
    }
    return { ok: true };
  }

  // One output, with everything a consumer needs to know how much to trust it.
  read(employeeId, outputId, via = null) {
    const o = this.ledger.get(outputId);
    if (!o) {
      this.audit.record({ action: 'consume', employee: employeeId, via, target: outputId, outcome: 'refused', reason: 'no such output' });
      return { ok: false, reason: 'no such output' };
    }
    const check = this.canConsume(employeeId, o);
    if (!check.ok) {
      this.audit.record({ action: 'consume', employee: employeeId, via, target: outputId, outcome: 'refused', reason: check.reason });
      return { ok: false, reason: check.reason };
    }
    this.audit.record({ action: 'consume', employee: employeeId, via, target: outputId, outcome: 'allowed' });
    return {
      ok: true,
      output: o,
      freshness: freshness(o),
      status: o.status,
      scope: describe(o.scope),
      provenance: {
        producer: o.producer,
        sources: o.sources,
        derived_from: o.derived_from,
        chain: this.ledger.ancestryOf(o.id),
        scope_basis: o.scope_basis,
      },
    };
  }

  // "What do we know about X" — answers only from what this employee may see.
  ask(employeeId, { kind, subject } = {}, via = null) {
    const candidates = this.ledger.all().filter((o) => {
      if (kind && o.kind !== kind) return false;
      if (subject && o.body?.subject !== subject) return false;
      return this.canConsume(employeeId, o).ok;
    });

    this.audit.record({
      action: 'consume', employee: employeeId, via,
      target: `query:${kind ?? '*'}/${subject ?? '*'}`,
      outcome: 'allowed', detail: { matched: candidates.length },
    });

    const live = candidates.filter((o) => o.state === 'live');
    const values = new Set(live.map((o) => JSON.stringify(o.body?.value ?? null)));
    const conflict = values.size > 1
      ? { conflict: true, note: 'more than one live answer disagrees; adjudicate, do not pick', outputs: live.map((o) => o.id) }
      : { conflict: false };

    return {
      ok: true,
      answers: candidates.map((o) => ({
        id: o.id, kind: o.kind, value: o.body?.value ?? null,
        status: o.status, freshness: freshness(o), as_of: o.as_of,
        scope: describe(o.scope),
        cite: { producer: o.producer, sources: o.sources, derived_from: o.derived_from },
        // An answer whose note records no source is unverified, and says so.
        unverified: o.sources.length === 0 && o.derived_from.length === 0,
      })),
      ...conflict,
    };
  }
}
