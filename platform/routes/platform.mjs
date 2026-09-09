// The platform-team API. Reachable only with a platform token.
//
// Note what is absent: there is no route here that reads an employee's fleet
// board. The platform team sees what crossed the boundary, not what a fleet was
// thinking. That absence is load-bearing and there is a check for it.
import { describe } from '../brain/scope.mjs';
import { freshness } from '../brain/schema.mjs';
import { newOutput } from '../brain/schema.mjs';
import { scopeReview } from '../platform-fleet/registry.mjs';

const ok = (body) => ({ status: 200, body: { ok: true, ...body } });
const created = (body) => ({ status: 201, body: { ok: true, ...body } });
const bad = (reason, status = 400) => ({ status, body: { ok: false, reason } });
const fail = (res, status = 400) => ({
  status,
  body: { ok: false, reason: (res.errors || ['failed']).join('; '), errors: res.errors, review: res.review },
});

const shape = (o) => ({
  id: o.id,
  kind: o.kind,
  subject: (o.body && o.body.subject) || null,
  value: (o.body && o.body.value) ?? null,
  producer: o.producer,
  state: o.state,
  status: o.status,
  freshness: freshness(o),
  scope: describe(o.scope),
  scope_basis: o.scope_basis || null,
  scope_declared_by_producer: o.scope_declared_by_producer || null,
  derived_from: o.derived_from,
  supersedes: o.supersedes || null,
  sources: o.sources,
  as_of: o.as_of,
  published_at: o.published_at,
  stale_reason: o.stale_reason || null,
  tombstone_reason: o.tombstone_reason || null,
  signer_state: o.signer_state,
  status_evidence: o.status_evidence || null,
});

export async function handlePlatform(ctx) {
  const { method, parts, query, body, principal, platform } = ctx;
  const actor = principal.employee;
  const seg = parts[0];

  // ---- the dashboard ----
  if (method === 'GET' && seg === 'overview') {
    const outputs = platform.ledger.all();
    const byState = outputs.reduce((a, o) => {
      a[o.state] = (a[o.state] || 0) + 1;
      return a;
    }, {});
    const byStatus = outputs.reduce((a, o) => {
      a[o.status] = (a[o.status] || 0) + 1;
      return a;
    }, {});
    const grants = platform.grants.all();
    return ok({
      actor: platform.identity.resolve(actor),
      agents: {
        total: platform.registry.all().length,
        published: platform.registry.all().filter((a) => a.lifecycle === 'published').length,
        retired: platform.registry.all().filter((a) => a.lifecycle === 'retired').length,
        internal: platform.registry.all().filter((a) => a.employee_reachable === false).length,
      },
      outputs: { total: outputs.length, by_state: byState, by_status: byStatus },
      conflicts: platform.ledger.conflicts(),
      queue: { open: platform.board.queue().length, total: platform.board.all().length },
      grants: { live: grants.filter((g) => g.live).length, total: grants.length },
      fleets: {
        total: platform.fleetRoster.all().length,
        active: platform.fleetRoster.all().filter((f) => f.state === 'active').length,
        agents: platform.fleetRoster.all().reduce((n, f) => n + f.agents.length, 0),
      },
      audit: platform.audit.summary(),
      deprecation_candidates: platform.telemetry.deprecationCandidates(),
      gates: platform.gates.registered(),
    });
  }

  // ---- the review queue ----
  if (seg === 'queue') {
    if (method === 'GET' && !parts[1]) {
      const items = platform.board.all().filter((i) => (query.state ? i.state === query.state : true));
      return ok({ items });
    }
    if (method === 'GET' && parts[1]) {
      const item = platform.board.get(parts[1]);
      return item ? ok({ item }) : bad('no such item', 404);
    }
    if (method === 'POST' && parts[1] && parts[2] === 'assign') {
      const res = platform.board.assign(parts[1], (body && body.to) || actor);
      return res.ok ? ok({ item: res.item }) : fail(res);
    }
    if (method === 'POST' && parts[1] && parts[2] === 'comment') {
      const res = platform.board.comment(actor, parts[1], body && body.text);
      return res.ok ? ok({ item: res.item }) : fail(res);
    }
    if (method === 'POST' && parts[1] && parts[2] === 'decide') {
      // An item here does not record an opinion, it changes something. The
      // board records the decision; this route applies the change and hands the
      // board the effect, so the thread says what actually happened rather than
      // what was intended.
      const decision = body && body.decision;
      const days = (body && body.days) || 30;
      const item = platform.board.get(parts[1]);
      if (!item) return bad('no such item', 404);
      if (item.state === 'closed') return bad('this item is already decided');
      if (!['approved', 'rejected'].includes(decision)) return bad('decision must be approved or rejected');

      let effect = null;
      if (decision === 'approved') {
        if (item.type === 'grant_request') {
          const g = platform.grants.issue({
            subject: item.payload.subject,
            agent: item.payload.agent,
            days,
            approved_by: actor,
            request_id: item.id,
            justification: item.payload.justification || null,
          });
          if (!g.ok) return fail(g);
          effect = { kind: 'grant_issued', grant: g.grant.id, expires_at: g.grant.expires_at };
        } else if (item.type === 'access_request') {
          const who = (item.payload.subject && item.payload.subject.id) || item.requester;
          const a = platform.registry.addToAccessList(item.payload.agent, who, actor);
          if (!a.ok) return fail(a);
          effect = { kind: 'access_widened', agent: item.payload.agent, employee: who };
        }
      }

      const res = platform.board.decide(parts[1], {
        decision,
        by: actor,
        note: body && body.note,
        effect,
      });
      return res.ok ? ok({ item: res.item }) : fail(res);
    }
  }

  // ---- the agent registry: the platform fleet's membership ----
  if (seg === 'registry') {
    if (method === 'GET' && parts[1] === 'reviews') return ok({ reviews: platform.registry.reviews().reverse() });
    if (method === 'GET' && !parts[1]) {
      return ok({
        agents: platform.registry.all().map((a) => ({
          ...a,
          access_list: platform.registry.accessList(a.id),
          scope_label: describe(a.scope),
          outputs: platform.ledger.all().filter((o) => o.producer.agent === a.id).length,
        })),
      });
    }
    if (method === 'POST' && parts[1] === 'review') {
      // Dry run the onboarding standard without publishing anything.
      return ok({ review: scopeReview(body && body.manifest) });
    }
    if (method === 'POST' && !parts[1]) {
      const manifest = body && body.manifest;
      const review = scopeReview(manifest);
      const res = platform.registry.publish(manifest, { reviewed_by: actor, review });
      if (!res.ok) return fail(res);
      platform.audit.record({
        action: 'lifecycle',
        employee: actor,
        target: manifest.id,
        outcome: 'allowed',
        detail: { event: 'onboarded', version: res.agent.version, scope: describe(manifest.scope) },
      });
      return created({ agent: res.agent, review: res.review });
    }
    if (method === 'POST' && parts[1] && parts[2] === 'retire') {
      const res = platform.registry.retire(parts[1], platform.ledger, body && body.reason);
      if (!res.ok) return fail(res);
      platform.audit.record({
        action: 'lifecycle',
        employee: actor,
        target: parts[1],
        outcome: 'allowed',
        detail: { event: 'retired', outputs_marked: res.outputs_marked },
      });
      return ok(res);
    }
    if (method === 'POST' && parts[1] && parts[2] === 'publish-output') {
      // The platform fleet's own agents publishing on cadence. Scope still comes
      // from the reviewed manifest, not from this request.
      const agent = platform.registry.get(parts[1]);
      if (!agent) return bad('no such agent', 404);
      const res = platform.ledger.publish(
        newOutput({
          id: (body && body.id) || parts[1] + '_' + Date.now().toString(36),
          kind: (body && body.kind) || agent.produces[0],
          producer: { fleet: 'enterprise', agent: parts[1], identity: agent.dri },
          body: (body && body.body) || {},
          sources: (body && body.sources) || [],
          derived_from: (body && body.derived_from) || [],
          ttl_seconds: (body && body.ttl_seconds) || null,
        }),
      );
      if (!res.ok) return fail(res);
      platform.gates.run(res.output.id);
      platform.audit.record({
        action: 'publish',
        employee: actor,
        target: res.output.id,
        outcome: 'allowed',
        detail: { agent: parts[1], scope: res.scope_label },
      });
      return created({ output: shape(platform.ledger.get(res.output.id)), scope_basis: res.scope_basis });
    }
  }

  // ---- the ledger ----
  if (seg === 'ledger') {
    if (method === 'GET' && !parts[1]) {
      const outputs = platform.ledger.all();
      return ok({
        outputs: outputs.map(shape),
        conflicts: platform.ledger.conflicts(),
        edges: outputs.flatMap((o) => (o.derived_from || []).map((p) => ({ from: p, to: o.id }))),
      });
    }
    if (method === 'GET' && parts[1]) {
      const o = platform.ledger.get(parts[1]);
      if (!o) return bad('no such output', 404);
      return ok({
        output: shape(o),
        ancestry: platform.ledger.ancestryOf(o.id),
        descendants: platform.ledger.descendantsOf(o.id),
      });
    }
    if (method === 'POST' && parts[1] === 'correct') {
      const old = platform.ledger.get(body && body.id);
      if (!old) return bad('no such output', 404);
      const res = platform.ledger.correct(
        old.id,
        newOutput({
          id: (body && body.new_id) || old.id + '_v' + (Date.now() % 1000),
          kind: old.kind,
          producer: old.producer,
          body: { subject: old.body.subject, value: body && body.value },
          sources: old.sources,
          derived_from: old.derived_from,
          ttl_seconds: old.ttl_seconds,
        }),
      );
      if (!res.ok) return fail(res);
      platform.gates.run(res.output.id);
      platform.audit.record({
        action: 'lifecycle',
        employee: actor,
        target: res.output.id,
        outcome: 'allowed',
        detail: { event: 'corrected', supersedes: old.id, invalidated: res.invalidated },
      });
      return created({
        output: shape(platform.ledger.get(res.output.id)),
        supersedes: old.id,
        invalidated: res.invalidated,
      });
    }
    if (method === 'POST' && parts[1] === 'tombstone') {
      const res = platform.ledger.tombstone(body && body.id, (body && body.reason) || 'deletion request');
      if (!res.ok) return fail(res);
      platform.audit.record({
        action: 'lifecycle',
        employee: actor,
        target: body.id,
        outcome: 'allowed',
        detail: { event: 'tombstoned', cascaded: res.cascaded, reason: body.reason || null },
      });
      return ok(res);
    }
  }

  // ---- quality gates: status from a check that can fail ----
  if (method === 'POST' && seg === 'gates' && parts[1] === 'run') {
    const results = body && body.id ? [platform.gates.run(body.id)] : platform.gates.runAll();
    return ok({ results });
  }

  // ---- grants ----
  if (seg === 'grants') {
    if (method === 'GET' && !parts[1]) return ok({ grants: platform.grants.all() });
    if (method === 'POST' && parts[1] && parts[2] === 'revoke') {
      const res = platform.grants.revoke(parts[1], actor);
      return res.ok ? ok({ grant: res.grant }) : fail(res);
    }
  }

  // ---- fleets: the one shared fact about an employee fleet ----
  if (seg === 'fleets') {
    if (method === 'GET' && !parts[1]) {
      return ok({
        fleets: platform.fleetRoster.all().map((f) => ({
          ...f,
          grants: platform.grants.forFleet(f.fleet).filter((g) => g.live).length,
          outputs: platform.ledger.all().filter((o) => o.producer.fleet === f.fleet).length,
          // Deliberately absent: anything from that fleet's board.
        })),
      });
    }
    if (method === 'POST' && parts[1] && parts[2] === 'archive') {
      const res = platform.fleetRoster.archive(parts[1], body && body.reason);
      if (!res.ok) return fail(res);
      platform.audit.record({
        action: 'lifecycle',
        employee: actor,
        target: parts[1],
        outcome: 'allowed',
        detail: { event: 'fleet_archived', reason: (body && body.reason) || null },
      });
      return ok(res);
    }
  }

  // ---- people ----
  if (seg === 'employees') {
    if (method === 'GET' && !parts[1]) {
      return ok({
        employees: platform.identity.all().map((e) => ({
          ...e,
          fleets: platform.fleetRoster.ownedBy(e.id).map((f) => f.fleet),
          signed_outputs: platform.ledger.all().filter((o) => o.producer.identity === e.id).length,
        })),
      });
    }
    // Offboarding: one action, and everything downstream of it follows.
    if (method === 'POST' && parts[1] && parts[2] === 'offboard') {
      const id = parts[1];
      const st = platform.identity.setStatus(id, 'former');
      if (!st.ok) return fail(st);
      const frozen = platform.ledger.freezeSigner(id);
      const archived = platform.fleetRoster.ownedBy(id).map((f) => platform.fleetRoster.archive(f.fleet, 'owner offboarded').fleet.fleet);
      for (const t of platform.tokens.list()) if (t.employee === id && !t.revoked) platform.tokens.revoke(t.token);
      platform.audit.record({
        action: 'lifecycle',
        employee: actor,
        target: id,
        outcome: 'allowed',
        detail: { event: 'offboarded', frozen: frozen.frozen, fleets_archived: archived },
      });
      return ok({ employee: id, frozen: frozen.frozen, fleets_archived: archived });
    }
  }

  // ---- audit and usage ----
  if (method === 'GET' && seg === 'audit') {
    return ok({
      rows: platform.audit.recent(Number(query.limit) || 200, {
        action: query.action,
        employee: query.employee,
        outcome: query.outcome,
      }),
      summary: platform.audit.summary(),
    });
  }

  if (method === 'GET' && seg === 'telemetry') {
    return ok({ usage: platform.telemetry.usage(), candidates: platform.telemetry.deprecationCandidates() });
  }

  // ---- tokens: the platform team issues one per fleet ----
  if (seg === 'tokens') {
    if (method === 'GET' && !parts[1]) {
      return ok({
        tokens: platform.tokens.list().map((t) => ({
          kind: t.kind,
          employee: t.employee,
          fleet: t.fleet,
          label: t.label,
          issued_at: t.issued_at,
          expires_at: t.expires_at,
          revoked: t.revoked,
          // The bearer value itself is never returned by this route.
          token_hint: t.token.slice(0, 8) + '...',
        })),
      });
    }
    if (method === 'POST' && !parts[1]) {
      const res = platform.tokens.issue({
        kind: (body && body.kind) || 'fleet',
        employee: body && body.employee,
        fleet: body && body.fleet,
        days: (body && body.days) || 30,
        label: body && body.label,
      });
      return res.ok ? created(res) : fail(res);
    }
  }

  return bad('no such platform route: ' + method + ' /' + parts.join('/'), 404);
}
