// The employee-fleet API. Everything a fleet can do, and nothing else.
//
// The employee and the fleet come from the token. Only the agent id comes from
// the request, and it is verified against the roster, or a fleet could borrow
// another agent's grant by claiming its id.
import { describe } from '../brain/scope.mjs';

const ok = (body) => ({ status: 200, body: { ok: true, ...body } });
const created = (body) => ({ status: 201, body: { ok: true, ...body } });
const bad = (reason, status = 400) => ({ status, body: { ok: false, reason } });
const fail = (res, status = 400) => ({ status, body: { ok: false, reason: (res.errors || ['failed']).join('; '), errors: res.errors } });

export async function handleFleet(ctx) {
  const { method, parts, query, body, principal, platform } = ctx;
  const employee = principal.employee;
  const fleetId = principal.fleet;

  const roster = platform.fleetRoster.get(fleetId);
  if (!roster) return bad('fleet ' + fleetId + ' is not registered', 403);
  if (roster.state !== 'active') return bad('fleet ' + fleetId + ' is ' + roster.state, 403);
  if (roster.owner !== employee) return bad('token fleet does not belong to token employee', 403);

  const F = platform.fleetFor(employee, fleetId);

  // The agent is the one thing the caller names, so it gets checked.
  const resolveVia = () => {
    const agent = (body && body.agent) || (body && body.via && body.via.agent) || query.agent || null;
    if (!agent) return { ok: false, reason: 'an agent id is required (query ?agent= or body.agent)' };
    if (!platform.fleetRoster.hasAgent(fleetId, agent)) {
      return { ok: false, reason: 'agent ' + agent + ' is not registered in ' + fleetId };
    }
    return { ok: true, via: { fleet: fleetId, agent } };
  };

  const seg = parts[0];

  // ---- who am I, and what can this fleet reach ----
  if (method === 'GET' && seg === 'context') {
    const who = platform.identity.resolve(employee);
    await F.board.syncDecisions();
    return ok({
      employee: { id: who.id, name: who.name, title: who.title },
      fleet: roster,
      agents: roster.agents,
      grants: platform.grants.forFleet(fleetId),
      tools: { available: F.tools.availableNow(), pending: F.tools.pending() },
      lanes: F.board.laneRegistry(),
      statuses: F.board.statuses(),
      kinds: F.board.kinds(),
      board_counts: F.board.all().reduce((acc, i) => {
        acc[i.status] = (acc[i.status] || 0) + 1;
        return acc;
      }, {}),
      waiting_on_you: F.board.waitingOnOwner().length,
      waiting_on_agents: F.board.waitingOnAgents().length,
      revision: F.board.revision(),
      visible_outputs: platform.ledger.visible(employee).length,
      note: 'this board is private: the platform team sees your consumes, invokes and published outputs, not this',
    });
  }

  if (method === 'GET' && seg === 'catalog') {
    const agent = query.agent || (roster.agents[0] && roster.agents[0].id) || null;
    return ok({ catalog: platform.gateway.catalogFor(employee, agent ? { fleet: fleetId, agent } : null) });
  }

  if (method === 'GET' && seg === 'tools') {
    return ok({ tools: F.tools.load() });
  }

  if (method === 'POST' && seg === 'tools') {
    if (!Array.isArray(body && body.requested)) return bad('requested must be an array of { name, class, invoke }');
    return ok({ tools: F.tools.choose(fleetId, body.requested) });
  }

  if (method === 'GET' && seg === 'connection') {
    const res = F.tools.connectionDescriptor({ fleet: fleetId, base_url: ctx.baseUrl });
    if (!res.ok) return fail(res);
    return ok({ descriptor: res.descriptor, path: res.path });
  }

  // ---- the board: instruct, propose, approve, report ----
  if (seg === 'board') {
    if (method === 'GET' && !parts[1]) {
      await F.board.syncDecisions();
      const showAll = query.all === '1' || query.all === 'true';
      return ok({
        items: F.board.all({ all: showAll }),
        // Two queues, and neither is the other: what needs a verdict from the
        // owner, and what an agent has not answered yet.
        waiting_on_you: F.board.waitingOnOwner().map((w) => ({
          item: w.item.id, entry: w.entry ? w.entry.id : null, why: w.why,
        })),
        waiting_on_agents: F.board.waitingOnAgents().map((w) => ({
          item: w.item.id, entry: w.entry.id, lane: w.item.lane,
        })),
        columns: Object.fromEntries(
          Object.entries(F.board.columns()).map(([k, v]) => [k, v.map((i) => i.id)]),
        ),
        revision: F.board.revision(),
      });
    }
    if (method === 'GET' && parts[1] === 'archived') {
      return ok({ items: F.board.archived() });
    }
    if (method === 'GET' && parts[1]) {
      const read = F.board.read(parts[1]);
      if (!read) return bad('no such item', 404);
      // The conversation and the bookkeeping come back separately, so a client
      // never has to filter change entries out of a thread by hand.
      return ok({ item: read.item, conversation: read.conversation, changes: read.changes, pending: read.pending });
    }
    if (method === 'POST' && parts[1] === 'instruct') {
      const res = F.board.instruct(employee, body && body.text, {
        title: body && body.title,
        lane: body && body.lane,
        kind: body && body.kind,
        status: body && body.status,
        tag: body && body.tag,
        next: body && body.next,
        due: body && body.due,
      });
      return res.ok ? created({ item: res.item }) : fail(res);
    }
    if (method === 'POST' && parts[1] === 'add') {
      const res = F.board.add(employee, body || {});
      return res.ok ? created({ item: res.item }) : fail(res);
    }
    if (method === 'POST' && parts[1] === 'sync') {
      const res = await F.board.syncDecisions();
      return ok({ updated: res.updated });
    }
    if (method === 'POST' && parts[1] && parts[2] === 'propose') {
      const res = F.board.propose(parts[1], {
        agent: body && body.agent,
        proposal: body && body.proposal,
        candidate: body && body.candidate,
        note: body && body.note,
      });
      return res.ok
        ? ok({ item: res.item, entry: res.entry, scope_preview: res.scope_preview })
        : fail(res);
    }
    // A verdict. On a plan it authorises and publishes nothing; on a proposal
    // carrying a candidate output it IS the publish, and the signer is the token
    // holder. `entry` targets one proposal; without it, the newest pending one.
    const verdictResponse = (res) => ok({
      item: res.item,
      verdict: res.verdict || null,
      published: res.published || null,
      output_id: res.published ? res.published.id : null,
      scope: res.published ? res.published.scope : null,
      scope_basis: res.published ? res.published.basis : null,
    });
    const auditPublish = (res) => {
      if (!res.published) return;
      platform.audit.record({
        action: 'publish',
        employee,
        via: { fleet: fleetId, agent: res.item.lane },
        target: res.published.id,
        outcome: 'allowed',
        detail: { scope: res.published.scope, basis: res.published.basis, item: res.item.id },
      });
    };

    if (method === 'POST' && parts[1] && parts[2] === 'decide') {
      const verdict = body && body.verdict;
      const entryId = body && body.entry;
      const res = entryId
        ? F.board.decide(employee, parts[1], entryId, { verdict, note: body && body.note })
        : verdict === 'rejected'
          ? F.board.reject(employee, parts[1], (body && body.note) || 'rejected')
          : F.board.approve(employee, parts[1], body && body.note);
      if (!res.ok) return fail(res);
      auditPublish(res);
      return verdictResponse(res);
    }
    if (method === 'POST' && parts[1] && parts[2] === 'approve') {
      const res = F.board.approve(employee, parts[1], body && body.note);
      if (!res.ok) return fail(res);
      auditPublish(res);
      return verdictResponse(res);
    }
    if (method === 'POST' && parts[1] && parts[2] === 'reject') {
      const res = F.board.reject(employee, parts[1], (body && body.why) || (body && body.note));
      return res.ok ? ok({ item: res.item, verdict: 'rejected' }) : fail(res);
    }
    // Field changes, and the two ways work leaves the board. Each writes its own
    // change entry, so an item can always say how it got here.
    if (method === 'POST' && parts[1] && parts[2] === 'patch') {
      const res = F.board.patch(employee, parts[1], body || {});
      return res.ok
        ? ok({ item: res.item, change: res.change || null, unchanged: Boolean(res.unchanged) })
        : fail(res);
    }
    if (method === 'POST' && parts[1] && ['park', 'unpark', 'archive', 'restore'].includes(parts[2])) {
      const res = parts[2] === 'park'
        ? F.board.park(employee, parts[1], body && body.reason)
        : parts[2] === 'unpark'
          ? F.board.unpark(employee, parts[1])
          : parts[2] === 'archive'
            ? F.board.archive(employee, parts[1], body && body.reason)
            : F.board.restore(employee, parts[1]);
      return res.ok ? ok({ item: res.item }) : fail(res);
    }
    if (method === 'POST' && parts[1] && parts[2] === 'note') {
      const res = F.board.note(employee, parts[1], body && body.text);
      return res.ok ? ok({ item: res.item }) : fail(res);
    }
    // A further instruction on an item that already exists. Without this the
    // loop only runs once per item, and a follow-up ask would have to open a
    // new item that loses the thread it belongs to.
    if (method === 'POST' && parts[1] && parts[2] === 'instruct') {
      const res = F.board.post(employee, parts[1], 'instruction', body && body.text);
      return res.ok ? created({ item: res.item, entry: res.entry }) : fail(res);
    }
    if (method === 'POST' && parts[1] && parts[2] === 'report') {
      const res = F.board.report(parts[1], { agent: body && body.agent, text: body && body.text });
      return res.ok ? ok({ item: res.item }) : fail(res);
    }
  }

  // ---- requests to the platform team: one out, a status back ----
  if (seg === 'requests') {
    if (method === 'POST' && !parts[1]) {
      const res = await F.board.raise(employee, {
        type: (body && body.type) || 'grant_request',
        agent: body && body.agent,
        target: body && body.target,
        justification: body && body.justification,
      });
      return res.ok ? created({ item: res.item, platform_item: res.platform_item }) : fail(res);
    }
    if (method === 'GET' && parts[1] && parts[2] === 'status') {
      const item = F.board.get(parts[1]);
      if (!item || !item.platform_request) return bad('no request on this item', 404);
      const st = await platform.link.status(employee, item.platform_request.id);
      return { status: st.ok ? 200 : 404, body: st };
    }
  }

  // ---- consume: the read path, no gateway, filtered by entitlements ----
  if (seg === 'ledger') {
    if (method === 'GET' && parts[1] === 'ask') {
      const via = resolveVia();
      if (!via.ok) return bad(via.reason, 403);
      return {
        status: 200,
        body: platform.query.ask(employee, { kind: query.kind, subject: query.subject }, via.via),
      };
    }
    if (method === 'GET' && parts[1] === 'outputs' && parts[2]) {
      const via = resolveVia();
      if (!via.ok) return bad(via.reason, 403);
      const res = platform.query.read(employee, parts[2], via.via);
      // A refusal is a 403 with the reason, because asking for access is the
      // actionable next step. Pretending it is a 404 hides that.
      return { status: res.ok ? 200 : 403, body: res };
    }
    if (method === 'POST' && parts[1] === 'scope-preview') {
      const via = resolveVia();
      if (!via.ok) return bad(via.reason, 403);
      const candidate = { ...(body && body.candidate), producer: { fleet: fleetId, agent: via.via.agent, identity: employee } };
      const res = platform.ledger.previewScope(candidate);
      return res.ok ? ok(res) : fail(res);
    }
    if (method === 'POST' && parts[1] === 'widen' && body && body.output_id) {
      // Always refused, with the person who would have to agree instead.
      return { status: 403, body: platform.ledger.attemptWiden(body.output_id, body.scope || { type: 'org' }) };
    }
  }

  // ---- invoke: the only write path up, re-authorised on every call ----
  if (method === 'POST' && seg === 'gateway' && parts[1] === 'invoke') {
    const via = resolveVia();
    if (!via.ok) return bad(via.reason, 403);
    if (!body.target || !body.op) return bad('target and op are required');
    const res = platform.gateway.invoke({
      employee,
      via: via.via,
      target: body.target,
      op: body.op,
      args: body.args || {},
      // An approval is only ever the caller approving their own agent's write.
      // A request cannot name a different approver.
      approval: body.approval ? { approved_by: employee } : null,
    });
    return { status: res.ok ? 200 : 403, body: res };
  }

  // ---- my own published outputs, for the cockpit ----
  if (method === 'GET' && seg === 'outputs') {
    const mine = platform.ledger
      .all()
      .filter((o) => o.producer.fleet === fleetId)
      .map((o) => ({
        id: o.id,
        kind: o.kind,
        subject: o.body && o.body.subject,
        state: o.state,
        status: o.status,
        scope: describe(o.scope),
        scope_basis: o.scope_basis,
        stale_reason: o.stale_reason || null,
        derived_from: o.derived_from,
        published_at: o.published_at,
      }));
    return ok({ outputs: mine });
  }

  return bad('no such fleet route: ' + method + ' /' + parts.join('/'), 404);
}
