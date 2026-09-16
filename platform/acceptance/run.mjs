// The roadmap's exit tests, as runnable checks.
// Each check names the phase or decision it proves. A phase that cannot pass its
// check has not shipped, whatever the code says.
import { existsSync, readdirSync } from 'node:fs';
import { readLines, readDoc } from '../brain/store.mjs';
import { newOutput } from '../brain/schema.mjs';
import { assertNoStoredEntitlements } from '../brain/identity.mjs';
import { describe, intersect, intersectAll, fleetScope, listScope, visibleTo } from '../brain/scope.mjs';
import { createDocumentBackend } from '../brain/store.mjs';
import { ENTRY_KINDS } from '../brain/board.mjs';
import {
  world, onboard, manifest, enterpriseOutput,
  phase, check, assert, assertEqual, report,
} from './harness.mjs';

const soon = () => new Date(Date.now() + 3600_000).toISOString();

// ───────────────────────────── PHASE 1 ─────────────────────────────
phase('Phase 1 — output ledger and provenance cascade');

await check('correcting an upstream output invalidates everything derived from it', () => {
  const w = world();
  onboard(w, manifest({ id: 'wh-metrics', connectors: [], scope: { type: 'org' } }));

  enterpriseOutput(w, { id: 'A', agent: 'wh-metrics', subject: 'q4', value: 100 });
  w.ledger.publish(newOutput({
    id: 'B', kind: 'metric', producer: { fleet: 'f_sarah', agent: 'analyst', identity: 'sarah' },
    body: { subject: 'q4', value: 200 }, derived_from: ['A'],
  }));
  w.ledger.publish(newOutput({
    id: 'C', kind: 'metric', producer: { fleet: 'f_sarah', agent: 'writer', identity: 'sarah' },
    body: { subject: 'q4', value: 300 }, derived_from: ['B'],
  }));

  assertEqual(w.ledger.freshnessOf('B'), 'fresh', 'B should start fresh');
  const res = w.ledger.correct('A', enterpriseCorrection());
  assert(res.ok, 'correction should publish');

  assertEqual(w.ledger.freshnessOf('A'), 'stale', 'A superseded');
  assertEqual(w.ledger.freshnessOf('B'), 'stale', 'B is one hop downstream');
  assertEqual(w.ledger.freshnessOf('C'), 'stale', 'C is two hops downstream');
  return `cascade reached ${res.invalidated.join(', ')}`;

  function enterpriseCorrection() {
    return newOutput({
      id: 'A2', kind: 'metric', producer: { fleet: 'enterprise', agent: 'wh-metrics', identity: 'priya' },
      body: { subject: 'q4', value: 111 }, sources: [{ system: 'warehouse', ref: 'q:A2' }], status: 'verified',
    });
  }
});

await check('a deriving agent cannot widen its own output scope (D7)', () => {
  const w = world();
  onboard(w, manifest({ id: 'narrow', connectors: [], scope: { type: 'list', members: ['sarah'] } }));
  onboard(w, manifest({ id: 'wide', connectors: [], scope: { type: 'org' }, produces: ['metric'] }));

  enterpriseOutput(w, { id: 'N', agent: 'narrow', subject: 'deal', value: 1 });
  enterpriseOutput(w, { id: 'W', agent: 'wide', subject: 'deal', value: 2 });

  // The producer asks for org-wide. The ledger ignores it and computes.
  const res = w.ledger.publish(newOutput({
    id: 'D', kind: 'metric', producer: { fleet: 'f_sarah', agent: 'analyst', identity: 'sarah' },
    body: { subject: 'deal', value: 3 }, derived_from: ['N', 'W'],
    scope: { type: 'org' },
  }));
  assert(res.ok, 'derived output should publish');

  const d = w.ledger.get('D');
  assertEqual(d.scope, { type: 'list', members: ['sarah'] }, 'scope must be the narrower input');
  assertEqual(d.scope_declared_by_producer, { type: 'org' }, 'the attempt is kept for audit');

  const widen = w.ledger.attemptWiden('D', { type: 'org' });
  assert(widen.ok === false, 'widening must be refused');
  return `computed ${describe(d.scope)}; widening refused and routed to ${describe(widen.route_to)}`;
});

await check('an output built on a harness connector is fleet-private (D11)', () => {
  const w = world();
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'inbox' }] });

  const res = w.ledger.publish(newOutput({
    id: 'H', kind: 'digest', producer: { fleet: 'f_sarah', agent: 'inbox', identity: 'sarah' },
    body: { subject: 'inbox', value: 'summary' },
    sources: [{ system: 'gmail', ref: 'thread/123', harness: true }],
    scope: { type: 'org' },
  }));
  assert(res.ok, 'should publish');
  assertEqual(w.ledger.get('H').scope, { type: 'fleet', fleet: 'f_sarah' }, 'must floor at fleet-private');
  return w.ledger.get('H').scope_basis;
});

await check('deletion is a tombstone plus a cascade, never a hard delete (D15)', () => {
  const w = world();
  onboard(w, manifest({ id: 'wh', connectors: [], scope: { type: 'org' } }));
  enterpriseOutput(w, { id: 'P', agent: 'wh', subject: 'pii', value: 'personal' });
  w.ledger.publish(newOutput({
    id: 'Q', kind: 'metric', producer: { fleet: 'f_raj', agent: 'a', identity: 'raj' },
    body: { subject: 'pii', value: 'derived' }, derived_from: ['P'],
  }));

  const res = w.ledger.tombstone('P', 'subject access request');
  assert(res.ok, 'tombstone should succeed');
  const p = w.ledger.get('P');
  assert(p !== null, 'the row survives so provenance still resolves');
  assertEqual(p.state, 'tombstoned', 'state is tombstoned');
  assertEqual(p.body, {}, 'the body is emptied');
  assertEqual(w.ledger.freshnessOf('Q'), 'stale', 'downstream goes stale');
  return `tombstoned P, cascaded to ${res.cascaded.join(', ')}`;
});

await check("a departed employee's outputs survive frozen (D16)", () => {
  const w = world();
  w.fleets.register({ fleet: 'f_dev', owner: 'sarah', agents: [{ id: 'a' }] });
  w.ledger.publish(newOutput({
    id: 'F1', kind: 'note', producer: { fleet: 'f_dev', agent: 'a', identity: 'sarah' },
    body: { subject: 'handover', value: 'x' },
  }));

  const res = w.ledger.freezeSigner('sarah');
  const o = w.ledger.get('F1');
  assertEqual(o.signer_state, 'former', 'signer marked former');
  assertEqual(o.state, 'frozen', 'output frozen, not deleted');
  assert(o.body.value === 'x', 'the content survives');
  const arch = w.fleets.archive('f_dev', 'left the company');
  assertEqual(arch.fleet.state, 'archived', 'fleet archived');
  return `froze ${res.frozen.join(', ')} and archived the fleet`;
});

// ───────────────────────────── PHASE 2 ─────────────────────────────
phase('Phase 2 — identity, consume path, audit');

await check('two employees ask the same question and correctly get different answers', () => {
  const w = world();
  onboard(w, manifest({ id: 'both', connectors: [], scope: { type: 'list', members: ['sarah', 'raj'] }, produces: ['metric'] }));
  onboard(w, manifest({ id: 'sarah-only', connectors: [], scope: { type: 'list', members: ['sarah'] }, produces: ['metric'] }));

  enterpriseOutput(w, { id: 'S1', agent: 'both', subject: 'q4', value: 42 });
  enterpriseOutput(w, { id: 'S2', agent: 'sarah-only', subject: 'q4', value: 42 });

  const sarah = w.query.ask('sarah', { kind: 'metric', subject: 'q4' });
  const raj = w.query.ask('raj', { kind: 'metric', subject: 'q4' });

  assertEqual(sarah.answers.length, 2, 'sarah sees both');
  assertEqual(raj.answers.length, 1, 'raj sees only the one he is entitled to');
  assertEqual(raj.answers[0].id, 'S1', 'and it is the right one');

  const reads = w.audit.all().filter((e) => e.action === 'consume');
  assert(reads.length >= 2, 'both reads are in the audit log');
  return `sarah ${sarah.answers.length}, raj ${raj.answers.length}, ${reads.length} reads audited`;
});

await check('an answer carries provenance, status and freshness', () => {
  const w = world();
  onboard(w, manifest({ id: 'wh', connectors: [], scope: { type: 'org' } }));
  enterpriseOutput(w, { id: 'A', agent: 'wh', subject: 'q4', value: 7 });
  w.ledger.publish(newOutput({
    id: 'B', kind: 'metric', producer: { fleet: 'f_sarah', agent: 'analyst', identity: 'sarah' },
    body: { subject: 'q4', value: 8 }, derived_from: ['A'],
  }));

  const r = w.query.read('sarah', 'B');
  assert(r.ok, r.reason);
  assertEqual(r.provenance.derived_from, ['A'], 'cites its input');
  assertEqual(r.provenance.chain.map((c) => c.id), ['A'], 'walks the chain');
  assert(r.freshness === 'fresh' && r.status === 'unverified', 'reports freshness and status separately');
  return `freshness=${r.freshness} status=${r.status} scope=${r.scope}`;
});

await check('the brain stores no entitlements anywhere (kill-risk 2)', () => {
  const w = world();
  onboard(w, manifest({ id: 'wh', connectors: [], scope: { type: 'org' } }));
  enterpriseOutput(w, { id: 'A', agent: 'wh', subject: 'q4', value: 1 });
  w.query.read('sarah', 'A');
  w.grants.issue({ subject: { type: 'employee', id: 'sarah' }, agent: 'wh', expires_at: soon(), approved_by: 'priya' });

  const persisted = [
    ...readLines(w.paths.ledger),
    ...readLines(w.paths.audit),
    readDoc(w.paths.registry, {}),
    readDoc(w.paths.grants, {}),
    readDoc(w.paths.fleetRoster, {}),
  ];
  const offenders = assertNoStoredEntitlements(persisted);
  assertEqual(offenders, [], `entitlements leaked into brain storage at ${offenders.join(', ')}`);

  // And prove they DO live in the IdP, outside the brain.
  const idp = readDoc(w.paths.idp, {});
  assert(idp.employees.sarah.entitlements.length > 0, 'the IdP is where entitlements live');
  return 'brain persists only employee ids; entitlements resolve live from the IdP';
});

await check('a former employee cannot consume', () => {
  const w = world();
  onboard(w, manifest({ id: 'wh', connectors: [], scope: { type: 'org' } }));
  enterpriseOutput(w, { id: 'A', agent: 'wh', subject: 'q4', value: 1 });
  const r = w.query.read('dev', 'A');
  assert(!r.ok, 'must be refused');
  assert(/not active/.test(r.reason), r.reason);
  return r.reason;
});

// ───────────────────────────── PHASE 3 ─────────────────────────────
phase('Phase 3 — enterprise onboarding, registry, first connector');

await check('onboarding a scoped agent takes a manifest and a review, no platform code', () => {
  const w = world();
  const { review, result } = onboard(w, manifest());
  assert(result.ok, JSON.stringify(result.errors));
  assertEqual(w.registry.accessList('incident-summary'), ['sarah', 'raj'], 'access list comes from the manifest');
  assertEqual(result.agent.version, 1, 'versioned on publish');
  assert(review.findings.length === 1 && review.findings[0].severity === 'advisory', 'service-account note raised');
  return `published v1 with ${review.findings.length} advisory finding`;
});

await check('scope review blocks org-wide reach over a service-account connector (D6)', () => {
  const w = world();
  const { review, result } = onboard(w, manifest({ id: 'snow-wide', scope: { type: 'org' } }));
  assert(review.blocking, 'review must block');
  assert(!result.ok, 'publish must be refused');
  return review.findings[0].remedy;
});

await check('the same agent is publishable as platform_internal', () => {
  const w = world();
  const { review, result } = onboard(w, manifest({ id: 'snow-internal', scope: { type: 'org' }, employee_reachable: false }));
  assert(!review.blocking, 'no longer blocking');
  assert(result.ok, JSON.stringify(result.errors));
  assertEqual(w.registry.accessList('snow-internal'), [], 'reachable by no employee fleet');
  return 'platform-internal: outputs get published, the agent is not exposed';
});

await check('retiring an agent marks its outputs stale', () => {
  const w = world();
  onboard(w, manifest({ id: 'wh', connectors: [], scope: { type: 'org' } }));
  enterpriseOutput(w, { id: 'A', agent: 'wh', subject: 'q4', value: 1 });
  w.ledger.publish(newOutput({
    id: 'B', kind: 'metric', producer: { fleet: 'f_raj', agent: 'a', identity: 'raj' },
    body: { subject: 'q4', value: 2 }, derived_from: ['A'],
  }));

  const res = w.registry.retire('wh', w.ledger);
  assert(res.ok, 'retire should succeed');
  assertEqual(w.ledger.freshnessOf('A'), 'tombstoned', 'its outputs are marked');
  assertEqual(w.ledger.freshnessOf('B'), 'stale', 'and downstream cascades');
  return `retired wh, marked ${res.outputs_marked.join(', ')}`;
});

await check('the platform board is thin: items, assignee, decision, audit record (D19)', () => {
  const w = world();
  const sub = w.board.submit({ type: 'agent_onboarding', subject: 'incident-summary', requester: 'priya' });
  assert(sub.ok, 'submit');
  w.board.assign(sub.item.id, 'priya');
  const dec = w.board.decide(sub.item.id, { decision: 'approved', by: 'priya', note: 'scope reviewed' });
  assert(dec.ok, 'decide');

  const item = w.board.get(sub.item.id);
  // Assert the DEFERRAL, not an exact field list. A whitelist breaks on every
  // legitimate change to the item and stops saying anything about Phase 6.
  const deferred = [
    'sla', 'sla_due', 'breached', 'escalated_to', 'escalation',
    'recurring', 'review_cadence', 'next_review_at',
    'conflict', 'conflicts_with', 'adjudication', 'adjudicated_by',
    'priority', 'severity',
  ];
  const present = deferred.filter((f) => f in item);
  assertEqual(present, [], 'no SLA, recurring-review or adjudication fields yet — those are Phase 6');

  // What it must have to be a queue at all.
  for (const f of ['id', 'type', 'requester', 'state', 'assignee', 'decision', 'decided_by', 'decided_at', 'thread']) {
    assert(f in item, `a queue item needs ${f}`);
  }

  const audited = w.audit.all().filter((e) => e.action === 'decision');
  assertEqual(audited.length, 1, 'every decision is an audit record');
  return 'thin queue verified; governance fields deliberately absent';
});

// ───────────────────────────── PHASE 4 ─────────────────────────────
phase('Phase 4 — employee fleet self-serve');

await check('an employee stands up a fleet and consumes with nothing granted by hand', () => {
  const w = world();
  onboard(w, manifest({ id: 'wh', connectors: [], scope: { type: 'list', members: ['sarah'] } }));
  enterpriseOutput(w, { id: 'A', agent: 'wh', subject: 'q4', value: 5 });

  const reg = w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }, { id: 'writer' }] });
  assert(reg.ok, 'registration needs no approval (D2)');
  assertEqual(reg.fleet.harness, 'claude', 'the sanctioned harness (D12)');

  const r = w.query.read('sarah', 'A', { fleet: 'f_sarah', agent: 'analyst' });
  assert(r.ok, r.reason);
  const viaAudit = w.audit.all().find((e) => e.via?.agent === 'analyst');
  assert(viaAudit, 'the acting agent is recorded, on whose behalf');
  return 'consumed on first run with zero manual grants';
});

await check('an ungranted invoke is refused by the gateway, not by the model (D13)', () => {
  const w = world();
  onboard(w, manifest({ id: 'snow', invocable: true, scope: { type: 'list', members: ['sarah'] } }));
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });

  const res = w.gateway.invoke({
    employee: 'sarah', via: { fleet: 'f_sarah', agent: 'analyst' },
    target: 'snow', op: 'incident.summary',
  });
  assert(!res.ok, 'must be refused');
  assertEqual(res.stage, 'grant', 'refused at the grant check');
  assert(w.audit.refusals().length === 1, 'the refusal is audited');
  return res.reason;
});

await check('bypassing local enforcement changes nothing — the gateway still refuses', () => {
  const w = world();
  onboard(w, manifest({ id: 'snow', invocable: true, scope: { type: 'list', members: ['sarah'] } }));
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });

  const off = w.fleet('sarah', 'f_sarah').enforcement({ enabled: false });
  const local = off.check({ employee: 'sarah', via: { fleet: 'f_sarah', agent: 'analyst' }, target: 'snow' });
  assert(local.allow === true, 'a disabled local check waves it through');
  assert(local.advisory === true, 'and says it is only advisory');

  const res = w.gateway.invoke({
    employee: 'sarah', via: { fleet: 'f_sarah', agent: 'analyst' },
    target: 'snow', op: 'incident.summary',
  });
  assert(!res.ok && res.stage === 'grant', 'the gateway is unmoved');
  return 'local bypass permitted; authoritative refusal still applied';
});

await check('the fleet board approve step is the publish gate (D9)', () => {
  const w = world();
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });
  const board = w.fleet('sarah', 'f_sarah').board;

  const item = board.instruct('sarah', 'summarise my inbox for the week').item;
  board.propose(item.id, {
    agent: 'analyst',
    candidate: {
      id: 'W1', kind: 'digest', body: { subject: 'inbox', value: 'weekly summary' },
      sources: [{ system: 'gmail', ref: 'label/inbox', harness: true }],
    },
    note: 'drafted from this week of mail',
  });

  assertEqual(w.ledger.all().length, 0, 'nothing reaches the ledger before approval');
  const res = board.approve('sarah', item.id);
  assert(res.ok, JSON.stringify(res.errors));
  assertEqual(w.ledger.all().length, 1, 'approval published exactly one output');
  assertEqual(res.output.scope, { type: 'fleet', fleet: 'f_sarah' }, 'and it is fleet-private (D11)');
  return `approve published ${res.output.id} at ${describe(res.output.scope)}`;
});

await check("another employee cannot drive someone else's fleet board (D10)", () => {
  const w = world();
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });
  const board = w.fleet('sarah', 'f_sarah').board;
  const item = board.instruct('sarah', 'private draft').item;
  const res = board.approve('raj', item.id);
  assert(!res.ok, 'raj must not be able to approve on sarah\'s board');
  return res.errors[0];
});

// ───────────────────────────── PHASE 5 ─────────────────────────────
phase('Phase 5 — invoke, gated');

await check('a granted agent invokes; an identical ungranted agent is refused; both audited', () => {
  const w = world();
  onboard(w, manifest({ id: 'snow', invocable: true, scope: { type: 'list', members: ['sarah', 'raj'] } }));
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });
  w.fleets.register({ fleet: 'f_raj', owner: 'raj', agents: [{ id: 'analyst' }] });

  w.grants.issue({
    subject: { type: 'fleet_agent', fleet: 'f_sarah', agent: 'analyst' },
    agent: 'snow', expires_at: soon(), approved_by: 'priya',
  });

  const ok = w.gateway.invoke({
    employee: 'sarah', via: { fleet: 'f_sarah', agent: 'analyst' },
    target: 'snow', op: 'incident.summary',
  });
  assert(ok.ok, ok.reason);
  assert(ok.published, 'the vendor result became a typed output');

  const no = w.gateway.invoke({
    employee: 'raj', via: { fleet: 'f_raj', agent: 'analyst' },
    target: 'snow', op: 'incident.summary',
  });
  assert(!no.ok && no.stage === 'grant', 'the identical ungranted agent is refused');

  const invokes = w.audit.all().filter((e) => e.action === 'invoke');
  assertEqual(invokes.length, 2, 'both appear in the audit log');
  assertEqual(invokes.map((e) => e.outcome), ['allowed', 'refused'], 'with their outcomes');
  return `granted -> ${ok.published}; ungranted refused; 2 audit rows`;
});

await check('every vendor write terminates at a human approval', () => {
  const w = world();
  onboard(w, manifest({ id: 'snow', invocable: true, scope: { type: 'list', members: ['sarah'] } }));
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });
  w.grants.issue({
    subject: { type: 'fleet_agent', fleet: 'f_sarah', agent: 'analyst' },
    agent: 'snow', expires_at: soon(), approved_by: 'priya',
  });

  const call = { employee: 'sarah', via: { fleet: 'f_sarah', agent: 'analyst' }, target: 'snow', op: 'incident.create', args: { short_description: 'api latency' } };
  const blocked = w.gateway.invoke(call);
  assert(!blocked.ok && blocked.stage === 'approval_required', 'a write without approval is refused');

  const allowed = w.gateway.invoke({ ...call, approval: { approved_by: 'sarah' } });
  assert(allowed.ok, allowed.reason);
  assertEqual(allowed.result.receipt.body.value.number, 'INC0042199', 'the write went through');
  return 'injection chain terminates: hostile content cannot reach a vendor write unattended';
});

await check('the gateway sheds rather than passing a stampede to the vendor', () => {
  const w = world();
  onboard(w, manifest({ id: 'snow', invocable: true, scope: { type: 'list', members: ['sarah'] }, rate_limit: { per_minute: 2 } }));
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });
  w.grants.issue({
    subject: { type: 'fleet_agent', fleet: 'f_sarah', agent: 'analyst' },
    agent: 'snow', expires_at: soon(), approved_by: 'priya',
  });

  const call = () => w.gateway.invoke({
    employee: 'sarah', via: { fleet: 'f_sarah', agent: 'analyst' },
    target: 'snow', op: 'incident.summary',
  });
  assert(call().ok, 'first call allowed');
  assert(call().ok, 'second call allowed');
  const third = call();
  assert(!third.ok && third.stage === 'rate_limit', 'third is shed at the limit');
  return third.reason;
});

await check('a revoked grant stops working immediately', () => {
  const w = world();
  onboard(w, manifest({ id: 'snow', invocable: true, scope: { type: 'list', members: ['sarah'] } }));
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });
  const g = w.grants.issue({
    subject: { type: 'fleet_agent', fleet: 'f_sarah', agent: 'analyst' },
    agent: 'snow', expires_at: soon(), approved_by: 'priya',
  });
  w.grants.revoke(g.grant.id, 'priya');
  const res = w.gateway.invoke({
    employee: 'sarah', via: { fleet: 'f_sarah', agent: 'analyst' },
    target: 'snow', op: 'incident.summary',
  });
  assert(!res.ok && res.stage === 'grant', 'revocation takes effect with no cleanup job');
  return res.reason;
});

await check('the grant request is the only coupling between the two boards (D18)', async () => {
  const w = world();
  onboard(w, manifest({ id: 'snow', invocable: true, scope: { type: 'list', members: ['sarah'] } }));
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });
  const board = w.fleet('sarah', 'f_sarah').board;

  const req = await board.requestGrant('sarah', { agent: 'analyst', target: 'snow', justification: 'weekly incident review' });
  assert(req.ok, 'request leaves the fleet board');
  assertEqual(w.board.queue().length, 1, 'and lands in the platform queue');

  // The requester sees only their own item's status.
  const mine = w.board.statusFor('sarah', req.platform_item);
  assert(mine.ok && mine.state === 'open', 'own status is visible');
  const theirs = w.board.statusFor('raj', req.platform_item);
  assert(!theirs.ok, 'someone else cannot read it');

  w.board.assign(req.platform_item, 'priya');
  w.board.decide(req.platform_item, { decision: 'approved', by: 'priya', note: 'time-boxed 30d' });
  const after = await board.grantStatus(req.item.id);
  assertEqual(after.decision, 'approved', 'the decision returns as a status');
  return 'request out, status back; neither side reads the other board';
});

// ───────────────────────────── PHASE 6 ─────────────────────────────
phase('Phase 6 — make it compound');

await check('an output status is set by a check that can fail, not by a claim', () => {
  const w = world();
  onboard(w, manifest({ id: 'wh', connectors: [], scope: { type: 'org' } }));
  enterpriseOutput(w, { id: 'G1', agent: 'wh', subject: 'revenue', value: -5 });

  w.gates.register('metric', (o) => ({
    pass: typeof o.body.value === 'number' && o.body.value >= 0,
    evidence: `value=${o.body.value} must be >= 0`,
  }));

  const res = w.gates.run('G1');
  assertEqual(res.status, 'gated', 'a failing check gates the output');
  assertEqual(w.ledger.get('G1').status, 'gated', 'and the ledger records it');

  enterpriseOutput(w, { id: 'G2', agent: 'wh', subject: 'revenue', value: 12 });
  assertEqual(w.gates.run('G2').status, 'verified', 'a passing check verifies it');
  return 'status is evidence, not assertion';
});

await check('telemetry surfaces an unused agent as a deprecation candidate', () => {
  const w = world();
  onboard(w, manifest({ id: 'used', connectors: [], scope: { type: 'org' } }));
  onboard(w, manifest({ id: 'unused', connectors: [], scope: { type: 'org' } }));
  enterpriseOutput(w, { id: 'U1', agent: 'used', subject: 'x', value: 1 });
  w.query.read('sarah', 'U1');

  const dead = w.telemetry.deprecationCandidates();
  assert(dead.some((d) => d.agent === 'unused'), 'the unused agent shows up');
  assert(!dead.some((d) => d.agent === 'used'), 'the used one does not');
  return `candidates: ${dead.map((d) => d.agent).join(', ')}`;
});

await check('conflicting live answers are surfaced, never resolved', () => {
  const w = world();
  onboard(w, manifest({ id: 'a1', connectors: [], scope: { type: 'org' }, produces: ['metric'] }));
  onboard(w, manifest({ id: 'a2', connectors: [], scope: { type: 'org' }, produces: ['metric'] }));
  enterpriseOutput(w, { id: 'X1', agent: 'a1', subject: 'q4', value: 100 });
  enterpriseOutput(w, { id: 'X2', agent: 'a2', subject: 'q4', value: 140 });

  const res = w.query.ask('sarah', { kind: 'metric', subject: 'q4' });
  assert(res.conflict === true, 'the disagreement is reported');
  assertEqual(res.outputs.sort(), ['X1', 'X2'], 'both sides are named');
  assertEqual(w.ledger.conflicts().length, 1, 'and the ledger agrees');
  return res.note;
});

// ──────────────────── MISSION CONTROL STRUCTURE ────────────────────
phase('Mission Control: items in lanes, work status, an append-only thread');

const fleetWith = (agents = [{ id: 'analyst', purpose: 'reads and reconciles' }]) => {
  const w = world();
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents });
  return { w, board: w.fleet('sarah', 'f_sarah').board };
};

const PLAN = {
  understanding: 'Reconcile the two revenue figures before Monday',
  actions: ['read both outputs', 'state both in the note', 'recommend the warehouse line'],
  needs: ['nothing'],
  caution: 'will not pick a winner between two live figures',
  source: 'agent',
};

await check('an item carries a lane, a kind and a work status, not just a thread position', () => {
  const { board } = fleetWith();
  const res = board.add('sarah', { title: 'Q3 reconciliation', lane: 'analyst', kind: 'task', status: 'blocked', next: 'chase the billing extract', tag: 'finance' });
  assert(res.ok, JSON.stringify(res.errors));
  const item = res.item;
  assertEqual(item.lane, 'analyst', 'the lane says who owns it');
  assertEqual(item.status, 'blocked', 'the status says where the WORK is');
  assertEqual(item.kind, 'task', 'the kind says what sort of thing it is');
  assert(item.next && item.touched, 'a next action and a touched date');
  return `${item.id}: ${item.lane} / ${board.statuses()[item.status].name} / next "${item.next}"`;
});

await check('a lane has to be an agent the fleet actually registered', () => {
  const { board } = fleetWith();
  const res = board.add('sarah', { title: 'x', lane: 'nobody' });
  assert(!res.ok, 'an unknown lane must be refused');
  return res.errors[0];
});

await check('a proposal must be answerable: understanding, actions, needs, source', () => {
  const { board } = fleetWith();
  const item = board.instruct('sarah', 'reconcile the two figures').item;
  const bad = board.propose(item.id, { agent: 'analyst', proposal: { understanding: 'sure', source: 'agent' } });
  assert(!bad.ok, 'a proposal with no actions cannot be proposed');
  const good = board.propose(item.id, { agent: 'analyst', proposal: PLAN });
  assert(good.ok, JSON.stringify(good.errors));
  assertEqual(good.entry.proposal.caution, PLAN.caution, 'what it will NOT do survives onto the thread');
  assertEqual(good.entry.replyTo, board.read(item.id).conversation[0].id, 'and it answers the instruction');
  return bad.errors[0];
});

await check('a verdict on a plan authorises it and executes nothing', () => {
  const { w, board } = fleetWith();
  const item = board.instruct('sarah', 'reconcile the two figures').item;
  const proposal = board.propose(item.id, { agent: 'analyst', proposal: PLAN }).entry;

  const res = board.decide('sarah', item.id, proposal.id, { verdict: 'approved', note: 'go' });
  assert(res.ok, JSON.stringify(res.errors));
  assertEqual(w.ledger.all().length, 0, 'approving a plan publishes nothing');

  const t = board.read(item.id).conversation;
  assertEqual(t.map((e) => e.kind), ['instruction', 'proposal', 'decision'], 'the thread reads as a conversation');
  assertEqual(t[1].verdict, 'approved', 'the proposal is stamped so the queue empties');
  return 'approved intent recorded; the agent still has to do the work and report';
});

await check('a verdict on a candidate output IS the publish, and the thread says so', () => {
  const { w, board } = fleetWith();
  const item = board.instruct('sarah', 'summarise my inbox').item;
  const proposal = board.propose(item.id, {
    agent: 'analyst',
    proposal: { ...PLAN, understanding: 'publish the weekly digest' },
    candidate: {
      id: 'W9', kind: 'digest', body: { subject: 'inbox', value: 'weekly summary' },
      sources: [{ system: 'gmail', ref: 'label/inbox', harness: true }],
    },
  });
  assert(proposal.ok, JSON.stringify(proposal.errors));
  assert(proposal.scope_preview.scope_label, 'the audience is shown before anyone signs');

  assertEqual(w.ledger.all().length, 0, 'nothing reaches the ledger before the verdict');
  const res = board.decide('sarah', item.id, proposal.entry.id, { verdict: 'approved' });
  assertEqual(w.ledger.all().length, 1, 'the verdict published exactly one output');

  const kinds = board.read(item.id).conversation.map((e) => e.kind);
  assertEqual(kinds, ['instruction', 'proposal', 'decision', 'report'], 'and a report records what happened');
  return `preview said ${proposal.scope_preview.scope_label}; published ${res.published.id} at ${res.published.scope}`;
});

await check('the audience is visible before anyone signs, and says when it was overruled', () => {
  const { w, board } = fleetWith();
  onboard(w, manifest({ id: 'narrow', connectors: [], scope: { type: 'list', members: ['sarah'] }, produces: ['metric'] }));
  enterpriseOutput(w, { id: 'N1', agent: 'narrow', subject: 'deal', value: 1 });

  const item = board.instruct('sarah', 'summarise the deal').item;
  const p = board.propose(item.id, {
    agent: 'analyst',
    proposal: PLAN,
    candidate: {
      id: 'D1', kind: 'metric', body: { subject: 'deal', value: 2 },
      derived_from: ['N1'],
      scope: { type: 'org' }, // the agent asks for org-wide
    },
  });
  assert(p.ok, JSON.stringify(p.errors));
  assertEqual(p.scope_preview.scope_label, '1 named: sarah', 'the preview computes the real audience');
  assert(p.scope_preview.overruled === true, 'and says the producer asked for something wider');
  assertEqual(w.ledger.all().length, 1, 'previewing writes nothing to the ledger');

  const res = board.decide('sarah', item.id, p.entry.id, { verdict: 'approved' });
  assertEqual(res.published.scope, p.scope_preview.scope_label, 'and the published scope matches what was shown');
  return `preview and publish agree: ${res.published.scope}`;
});

await check('a proposal cannot be decided twice', () => {
  const { board } = fleetWith();
  const item = board.instruct('sarah', 'x').item;
  const p = board.propose(item.id, { agent: 'analyst', proposal: PLAN }).entry;
  board.decide('sarah', item.id, p.id, { verdict: 'approved' });
  const again = board.decide('sarah', item.id, p.id, { verdict: 'rejected' });
  assert(!again.ok, 'a decided proposal is closed');
  return again.errors[0];
});

await check('a field change is an entry, so an item says how it got here', () => {
  const { board } = fleetWith();
  const item = board.add('sarah', { title: 'Q3 reconciliation', lane: 'analyst', status: 'now' }).item;
  const res = board.patch('sarah', item.id, { status: 'waiting', waitingOn: 'billing team', next: 'chase the extract' });
  assert(res.ok, JSON.stringify(res.errors));
  const changes = board.read(item.id).changes;
  assertEqual(changes.length, 1, 'one entry for the whole patch');
  assertEqual(changes[0].author, 'system', 'written by the board, never by hand');
  assert(!board.read(item.id).conversation.some((e) => e.kind === 'change'), 'and kept out of the conversation');

  const noop = board.patch('sarah', item.id, { status: 'waiting' });
  assert(noop.unchanged, 'a no-op patch writes no entry');
  return changes[0].body;
});

await check('a change entry cannot be forged by hand', () => {
  const { board } = fleetWith();
  const item = board.instruct('sarah', 'x').item;
  const res = board.post('sarah', item.id, 'change', 'Status: Blocked -> Done');
  assert(!res.ok, 'only the board writes change entries');
  return res.errors[0];
});

await check('parking is lossless: an item comes back to the status it left', () => {
  const { board } = fleetWith();
  const item = board.add('sarah', { title: 'later', lane: 'analyst', status: 'waiting', waitingOn: 'legal' }).item;
  board.park('sarah', item.id, 'client pushed the date');
  assertEqual(board.get(item.id).status, 'parked', 'parked items stay on the board');
  board.unpark('sarah', item.id);
  assertEqual(board.get(item.id).status, 'waiting', 'and return as waiting, not as in flight');
  return 'waiting -> parked -> waiting, with both moves on the thread';
});

await check('archiving is lossless and leaves the default board', () => {
  const { board } = fleetWith();
  const item = board.instruct('sarah', 'done with this').item;
  board.archive('sarah', item.id, 'superseded');
  assertEqual(board.all().length, 0, 'archived items leave the board');
  assertEqual(board.archived().length, 1, 'but nothing is deleted');
  board.restore('sarah', item.id);
  assertEqual(board.all().length, 1, 'and restore brings it back whole');
  return 'archive and restore keep every field';
});

await check('finished work leaves the default board without being archived', () => {
  const { board } = fleetWith();
  const item = board.instruct('sarah', 'ship it').item;
  board.patch('sarah', item.id, { status: 'shipped' });
  assertEqual(board.all().length, 0, 'shipped work is off the default board');
  assertEqual(board.all({ all: true }).length, 1, 'and still there when asked for');
  return 'done and shipped both close an item';
});

await check('every write bumps a revision, so a stale client can tell', () => {
  const { board } = fleetWith();
  const before = board.revision();
  board.instruct('sarah', 'something');
  assert(board.revision() > before, 'the revision moved');
  return `revision ${before} -> ${board.revision()}`;
});

await check('the board separates what waits on me from what waits on an agent', () => {
  const { board } = fleetWith([{ id: 'analyst' }, { id: 'briefer' }]);
  const answered = board.instruct('sarah', 'reconcile the figures', { lane: 'analyst' }).item;
  board.propose(answered.id, { agent: 'analyst', proposal: PLAN });
  const unanswered = board.instruct('sarah', 'draft the brief', { lane: 'briefer' }).item;

  const mine = board.waitingOnOwner();
  const theirs = board.waitingOnAgents();
  assertEqual(mine.length, 1, 'one proposal waits on the owner');
  assertEqual(mine[0].item.id, answered.id, 'the answered one');
  assertEqual(theirs.length, 1, 'one instruction waits on an agent');
  assertEqual(theirs[0].item.id, unanswered.id, 'the unanswered one');
  assertEqual(board.waitingOnAgents('analyst').length, 0, 'and it can be read per lane');
  return 'two queues, and neither is the other';
});

await check('both boards speak the same thread grammar', () => {
  const { w, board } = fleetWith();
  const item = board.instruct('sarah', 'x').item;
  const sub = w.board.submit({ type: 'agent_onboarding', subject: 'incident-summary', requester: 'priya' });
  w.board.assign(sub.item.id, 'priya');
  w.board.decide(sub.item.id, { decision: 'approved', by: 'priya', note: 'scope reviewed' });

  const fleetKinds = new Set(board.read(item.id).item.thread.map((e) => e.kind));
  const queueKinds = new Set(w.board.read(sub.item.id).item.thread.map((e) => e.kind));
  for (const k of [...fleetKinds, ...queueKinds]) {
    assert(ENTRY_KINDS.includes(k), `${k} is not a shared entry kind`);
  }
  assert(queueKinds.has('decision') && queueKinds.has('change'), 'the queue threads decisions and changes too');
  return `fleet: ${[...fleetKinds].join(', ')} | queue: ${[...queueKinds].join(', ')}`;
});

// ──────────────────── WORKSPACES, TOOLS, PLATFORM LINK ────────────────────
phase('Workspace separation, tool selection, platform link');

await check('employee storage and platform storage are separate trees', () => {
  const w = world();
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });
  const f = w.fleet('sarah', 'f_sarah');
  f.board.instruct('sarah', 'private draft nobody else should see');

  assert(existsSync(f.paths.board), 'the fleet board is written');
  assert(f.paths.board.includes('sarah'), 'inside a path scoped to that employee');
  assert(!f.paths.board.startsWith(w.paths.root), `the fleet board must not live under the platform root (${w.paths.root})`);

  // Nothing on the platform side names the board file.
  const platformFiles = readdirSync(w.paths.root);
  assert(!platformFiles.some((n) => n.includes('fleet-board')), 'no fleet board on the platform side');
  return `platform: ${w.paths.root} | employee: ${f.paths.root}`;
});

await check('two employees never share a storage file', () => {
  const w = world();
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'a' }] });
  w.fleets.register({ fleet: 'f_raj', owner: 'raj', agents: [{ id: 'a' }] });
  const a = w.fleet('sarah', 'f_sarah');
  const b = w.fleet('raj', 'f_raj');
  assert(a.paths.board !== b.paths.board, 'different board files');
  assert(a.paths.root !== b.paths.root, 'different workspace roots');
  a.board.instruct('sarah', 'mine');
  b.board.instruct('raj', 'his');
  assertEqual(a.board.all().length, 1, 'sarah sees only her item');
  assertEqual(b.board.all().length, 1, 'raj sees only his');
  return 'one workspace per employee, no shared file';
});

await check('fleet creation asks which tools are wanted and sorts them', () => {
  const w = world();
  onboard(w, manifest({ id: 'incident-desk', invocable: true, scope: { type: 'list', members: ['sarah'] } }));
  onboard(w, manifest({ id: 'closed-desk', connectors: [], scope: { type: 'list', members: ['raj'] } }));
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });
  const f = w.fleet('sarah', 'f_sarah');

  const chosen = f.tools.choose('f_sarah', [
    { name: 'gmail', class: 'harness' },
    { name: 'jira', class: 'harness' },
    { name: 'incident-desk', class: 'enterprise' },
    { name: 'incident-desk', class: 'enterprise', invoke: true },
    { name: 'closed-desk', class: 'enterprise' },
    { name: 'imaginary-desk', class: 'enterprise' },
  ]);

  const byWhy = (frag) => chosen.requested.filter((t) => t.why.includes(frag));
  assertEqual(f.tools.availableNow().length, 3, 'two harness tools plus one consume are usable immediately');
  assert(byWhy('authenticates as you').length === 2, 'harness tools need no grant (D3)');
  assert(chosen.requested.find((t) => t.invoke).needs.startsWith('grant'), 'invoke needs a grant request (D4)');
  assert(byWhy('not on the access list')[0].needs.startsWith('access'), 'a closed agent needs access first');
  assert(byWhy('no enterprise agent named')[0].available === false, 'an unknown agent is not offered');
  return `usable now: ${f.tools.availableNow().map((t) => t.name).join(', ')} | pending: ${f.tools.pending().length}`;
});

await check('the fleet gets a connection descriptor its harness can be pointed at', () => {
  const w = world();
  onboard(w, manifest({ id: 'incident-desk', invocable: true, scope: { type: 'list', members: ['sarah'] } }));
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }, { id: 'writer' }] });
  const f = w.fleet('sarah', 'f_sarah');
  f.tools.choose('f_sarah', [
    { name: 'gmail', class: 'harness' },
    { name: 'incident-desk', class: 'enterprise', invoke: true },
  ]);

  const res = f.tools.connectionDescriptor({
    fleet: 'f_sarah',
    ledger_url: 'https://brain.corp/ledger',
    gateway_url: 'https://brain.corp/gateway',
    platform_board_url: 'https://brain.corp/board',
  });
  assert(res.ok, JSON.stringify(res.errors));
  const d = res.descriptor;
  assertEqual(d.agents, ['analyst', 'writer'], 'names the fleet agents so grants can address them');
  assertEqual(d.harness, 'claude', 'names the harness');
  assert(d.endpoints.gateway && d.endpoints.ledger && d.endpoints.platform_board, 'all three endpoints present');
  assertEqual(d.tools.pending.length, 1, 'and states what is still pending a grant');
  assert(existsSync(f.paths.connection), 'written into the employee workspace');
  return `descriptor at ${f.paths.connection}`;
});

await check('the platform board works over a URL exactly as it does in-process', async () => {
  const w = world();
  onboard(w, manifest({ id: 'snow', invocable: true, scope: { type: 'list', members: ['sarah'] } }));
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });

  // Same board, reached over the URL client instead of directly.
  const f = w.fleet('sarah', 'f_sarah', { link: 'https://brain.corp/board' });
  assertEqual(f.platformLink.kind, 'url', 'using the URL link');

  const req = await f.board.requestGrant('sarah', { agent: 'analyst', target: 'snow', justification: 'weekly review' });
  assert(req.ok, JSON.stringify(req.errors));
  assertEqual(w.board.queue().length, 1, 'the request landed in the platform queue');

  w.board.assign(req.platform_item, 'priya');
  w.board.decide(req.platform_item, { decision: 'approved', by: 'priya', note: 'time-boxed 30d' });

  const status = await f.board.grantStatus(req.item.id);
  assertEqual(status.decision, 'approved', 'the decision came back over the URL');
  return 'direct and URL links are interchangeable';
});

await check('the URL route cannot be walked to read someone else\'s request', async () => {
  const w = world();
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });
  onboard(w, manifest({ id: 'snow', invocable: true, scope: { type: 'list', members: ['sarah'] } }));
  const f = w.fleet('sarah', 'f_sarah', { link: 'https://brain.corp/board' });
  const req = await f.board.requestGrant('sarah', { agent: 'analyst', target: 'snow', justification: 'x' });

  const mine = w.boardHandler({ method: 'GET', path: `/items/${req.platform_item}/status`, query: { requester: 'sarah' } });
  assertEqual(mine.status, 200, 'the requester can read their own');

  const theirs = w.boardHandler({ method: 'GET', path: `/items/${req.platform_item}/status`, query: { requester: 'raj' } });
  assertEqual(theirs.status, 404, 'anyone else gets nothing, not a permission hint');

  const listing = w.boardHandler({ method: 'GET', path: '/items' });
  assertEqual(listing.status, 404, 'there is no route that enumerates the queue');
  return 'two routes only; no enumeration path exists';
});

await check('a deployment ships with gates, and the seeded world proves both outcomes', async () => {
  const { seedWorld, DIRECTORY: SEED_DIRECTORY } = await import('../seed.mjs');
  const w = world({ idp: SEED_DIRECTORY });
  // Seeding runs the gates, so this is the label a person would actually see on
  // a fresh host rather than one arranged by the check.
  await seedWorld(w, { baseUrl: 'http://localhost' });

  assert(w.gates.registered().length > 0, 'a host with no gates registered can only ever say unverified');

  const byStatus = w.ledger.all().reduce((a, o) => {
    a[o.status] = (a[o.status] ?? 0) + 1;
    return a;
  }, {});
  assert(byStatus.verified > 0, 'something passed a gate');
  assert(byStatus.unverified > 0, 'and a kind with no gate stayed unverified');

  const passed = w.ledger.all().find((o) => o.status === 'verified');
  assert(passed.status_evidence?.evidence, 'a verified output carries the evidence that verified it');
  return `${byStatus.verified} verified, ${byStatus.unverified} unverified: "${passed.status_evidence.evidence}"`;
});

await check('every invocable agent has its connector wired', async () => {
  const { seedWorld, DIRECTORY: SEED_DIRECTORY } = await import('../seed.mjs');
  const w = world({ idp: SEED_DIRECTORY });
  await seedWorld(w, { baseUrl: 'http://localhost' });

  // An agent a manifest says is invocable, with no adapter behind it, refuses
  // every call at the last possible moment with a message about plumbing. The
  // registry and the connector set have to agree, and nothing else checks that.
  const orphans = [];
  for (const a of w.registry.all()) {
    if (!a.invocable) continue;
    const system = a.connectors?.[0]?.system;
    if (!system || !w.connectors[system]) orphans.push(`${a.id} -> ${system ?? 'no connector declared'}`);
  }
  assertEqual(orphans, [], 'an invocable agent with no adapter behind it');

  const wired = w.registry.all().filter((a) => a.invocable).map((a) => a.id);
  return `${wired.join(', ')} all have an adapter`;
});

await check('seeding twice leaves one world, not two', async () => {
  const { seedWorld, DIRECTORY: SEED_DIRECTORY } = await import('../seed.mjs');
  const { buildPlatform } = await import('../wire.mjs');
  const { platformWorkspace } = await import('../workspace.mjs');
  const root = 'data/reseed';

  // Exactly what `serve.mjs --seed` does, twice. A `fresh` that clears only the
  // platform side leaves every employee board behind, and the second run stacks
  // a whole second world on top of the first: the same items appear twice.
  const counts = [];
  for (let i = 0; i < 2; i += 1) {
    const p = buildPlatform({
      ws: platformWorkspace(`${root}/platform`),
      workspaceRoot: `${root}/workspaces`,
      fresh: true,
      idp: SEED_DIRECTORY,
    });
    await seedWorld(p, { baseUrl: 'http://localhost' });
    counts.push({
      items: p.fleetFor('alice', 'f_alice').board.all({ all: true }).length,
      outputs: p.ledger.all().length,
      queue: p.board.all().length,
    });
  }

  assertEqual(counts[1], counts[0], 'a second seeded start must produce the same world, not a doubled one');
  return `${counts[0].items} items, ${counts[0].outputs} outputs, ${counts[0].queue} queue items, both times`;
});

// ──────────────────── HOSTED STORAGE ────────────────────
phase('Hosted storage: the same brain with no filesystem under it');

// A deployment on a serverless platform has no durable disk, so storage becomes
// a document per workspace, hydrated before a request and flushed after. These
// checks run the real thing over a fake remote: identical semantics, nothing
// durable, no token.
const {
  setBackend, currentBackend, documentFor, createFilesystemBackend,
} = await import('../brain/store.mjs');
const { createFakeRemoteBackend, documentsFor } = await import('../brain/blob-store.mjs');

await check('a path maps to its own workspace document, never a shared one', () => {
  const a = documentFor('data/hosted/workspaces/alice/fleet-board.json');
  const b = documentFor('data/hosted/workspaces/bob/fleet-board.json');
  const p = documentFor('data/hosted/platform/ledger.jsonl');

  assertEqual(a.doc, 'workspaces/alice', "alice's board is her own document");
  assertEqual(b.doc, 'workspaces/bob', "bob's is his");
  assert(a.doc !== b.doc, 'two employees never share a document');
  assertEqual(p.doc, 'platform', 'and the platform side is its own');
  assertEqual([a.key, p.key], ['fleet-board.json', 'ledger.jsonl'], 'the key inside is the file name');
  // Windows separators reach this from join(), so they have to map the same way.
  assertEqual(documentFor('data\\hosted\\workspaces\\alice\\tools.json').doc, 'workspaces/alice', 'either separator');
  return `${a.doc} | ${b.doc} | ${p.doc}`;
});

await check('a read from a document nobody hydrated fails loudly', () => {
  const backend = createFakeRemoteBackend();
  const previous = currentBackend();
  setBackend(backend);
  try {
    let threw = null;
    try {
      backend.get('data/hosted/platform/registry.json');
    } catch (err) {
      threw = err.message;
    }
    // Returning null here would be indistinguishable from empty storage, and
    // the caller would write a fresh empty board over what is actually stored.
    assert(threw, 'an unhydrated read must throw, not look empty');
    assert(/was not hydrated/.test(threw), 'and say so');
    return threw.slice(0, 72) + '...';
  } finally {
    setBackend(previous);
  }
});

await check('the whole brain runs on the hosted backend and answers the same', async () => {
  const backend = createFakeRemoteBackend();
  const previous = currentBackend();
  setBackend(backend);
  try {
    const { seedWorld, DIRECTORY: SEED_DIRECTORY } = await import('../seed.mjs');
    const { build } = await import('../wire.mjs');

    // Order matters on this backend, and it is the same order the hosted entry
    // point uses: hydrate first, then build, then handle. `fresh` is for a
    // filesystem run only, because on a document backend it drops exactly the
    // documents that were just hydrated.
    await backend.hydrate(['platform', 'workspaces/alice', 'workspaces/bob', 'workspaces/carol']);
    const w = build({ root: 'data/hosted-check', idp: SEED_DIRECTORY });
    await seedWorld(w, { baseUrl: 'http://localhost' });

    // The same properties the filesystem checks prove, with no filesystem.
    const alice = w.query.ask('alice', { kind: 'metric', subject: 'q3_revenue' });
    const carol = w.query.ask('carol', { kind: 'metric', subject: 'q3_revenue' });
    assert(alice.answers.length > 0, 'alice sees the figures she is entitled to');
    assertEqual(carol.answers.length, 0, 'carol sees none of them');
    assert(alice.conflict === true, 'and the live conflict is still surfaced');

    const flushed = await backend.flush();
    assert(flushed.includes('platform'), 'the platform document was written');
    assert(flushed.includes('workspaces/alice'), "and alice's workspace");
    assert(backend.remote.size > 1, 'as separate documents in the remote');
    return `${flushed.length} documents flushed: ${flushed.join(', ')}`;
  } finally {
    setBackend(previous);
  }
});

await check('nothing is written when nothing changed', async () => {
  const backend = createFakeRemoteBackend();
  const previous = currentBackend();
  setBackend(backend);
  try {
    await backend.hydrate(['platform']);
    backend.set('data/hosted/platform/registry.json', '{"agents":{}}');
    assertEqual(await backend.flush(), ['platform'], 'a write flushes its document');

    backend.get('data/hosted/platform/registry.json');
    assertEqual(await backend.flush(), [], 'a read flushes nothing');
    return 'only dirty documents are written back';
  } finally {
    setBackend(previous);
  }
});

await check('a request hydrates the platform document and one workspace, never more', () => {
  assertEqual(documentsFor(null), ['platform'], 'before the caller is known, only the platform document');
  assertEqual(documentsFor('alice'), ['platform', 'workspaces/alice'], 'then their own workspace');
  assert(!documentsFor('alice').includes('workspaces/bob'), "and never somebody else's");
  return 'a hosted process holds only the workspace it was asked about';
});

// ──────────────────── THE BOARDS, AS SERVED PAGES ────────────────────
phase('The two boards a person can open, and the API behind them');

// A host with the local token list switched on, which is what `serve.mjs --seed`
// does and what no real deployment should do.
const withBoards = ({ devTokens = true } = {}) => {
  const w = world({ devTokens });
  onboard(w, manifest({ id: 'revenue-desk', connectors: [], scope: { type: 'list', members: ['sarah'] }, produces: ['metric'] }));
  enterpriseOutput(w, { id: 'rev_q4', agent: 'revenue-desk', subject: 'q4', value: 100 });
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst', purpose: 'reads' }] });
  const fleetToken = w.tokens.issue({ kind: 'fleet', employee: 'sarah', fleet: 'f_sarah', days: 30 }).token;
  const platformToken = w.tokens.issue({ kind: 'platform', employee: 'priya', days: 30 }).token;
  const call = (token, req) => w.host.handle({ ...req, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { w, fleetToken, platformToken, call };
};

await check('both boards and the landing page are served as pages', async () => {
  const { call } = withBoards();
  const seen = [];
  for (const path of ['/', '/fleet', '/platform']) {
    const res = await call(null, { method: 'GET', path });
    assertEqual(res.status, 200, `${path} should be served`);
    assert(String(res.contentType).startsWith('text/html'), `${path} should be HTML`);
    assert(res.body.length > 2000, `${path} should not be an empty shell`);
    seen.push(path);
  }
  return `${seen.join(', ')} served with no token, because a page carries none`;
});

await check('a page needs no token, and shows nothing until one is supplied', async () => {
  const { call } = withBoards();
  const page = (await call(null, { method: 'GET', path: '/fleet' })).body.toString();
  // The token travels in the URL fragment, which never reaches the server.
  assert(/#token=|location\.hash/.test(page), 'the page reads its token from the fragment');
  assert(!/ebt_[0-9a-f]{8}/.test(page), 'and no bearer value is baked into the page');
  return 'the fragment never reaches this process, so a page can be open';
});

await check('the two API surfaces do not overlap', async () => {
  const { call, fleetToken, platformToken } = withBoards();
  assertEqual((await call(fleetToken, { method: 'GET', path: '/api/fleet/context' })).status, 200, 'fleet token on a fleet route');
  assertEqual((await call(platformToken, { method: 'GET', path: '/api/platform/overview' })).status, 200, 'platform token on a platform route');

  const crossed = await call(fleetToken, { method: 'GET', path: '/api/platform/overview' });
  assertEqual(crossed.status, 403, 'a fleet token on a platform route is refused');
  const crossedBack = await call(platformToken, { method: 'GET', path: '/api/fleet/context' });
  assertEqual(crossedBack.status, 403, 'and the reverse holds too');
  return `${crossed.body.reason} / ${crossedBack.body.reason}`;
});

await check('the API needs a live token exactly as the endpoints do', async () => {
  const { call } = withBoards();
  assertEqual((await call(null, { method: 'GET', path: '/api/fleet/context' })).status, 401, 'no token');
  assertEqual((await call('ebt_nope', { method: 'GET', path: '/api/platform/overview' })).status, 401, 'unknown token');
  return 'a page is open; the data behind it is not';
});

await check('the board a fleet sees is its own, and it is the whole structure', async () => {
  const { call, fleetToken } = withBoards();
  const made = await call(fleetToken, {
    method: 'POST', path: '/api/fleet/board/instruct',
    body: { text: 'reconcile the quarter', lane: 'analyst', kind: 'task', status: 'blocked', next: 'chase the extract' },
  });
  assertEqual(made.status, 201, 'an item is created');
  assertEqual(made.body.item.lane, 'analyst', 'in a lane');
  assertEqual(made.body.item.status, 'blocked', 'with a work status of its own');

  const board = (await call(fleetToken, { method: 'GET', path: '/api/fleet/board' })).body;
  assertEqual(board.waiting_on_agents.length, 1, 'one instruction waits on an agent');
  assertEqual(board.waiting_on_you.length, 0, 'and nothing waits on the owner yet');
  assertEqual(Object.keys(board.columns).filter((k) => board.columns[k].length), ['blocked'], 'columns are keyed by status');

  const read = (await call(fleetToken, { method: 'GET', path: `/api/fleet/board/${made.body.item.id}` })).body;
  assertEqual(read.conversation.map((e) => e.kind), ['instruction'], 'the conversation excludes bookkeeping');
  assertEqual(read.pending, null, 'and nothing is pending a verdict');
  return `${made.body.item.id} in lane analyst, status blocked, one instruction waiting`;
});

await check('the local token list is off unless the host was told to serve it', async () => {
  const off = withBoards({ devTokens: false });
  assertEqual((await off.call(null, { method: 'GET', path: '/api/dev/tokens' })).status, 404, 'off by default');

  const on = withBoards();
  const res = await on.call(null, { method: 'GET', path: '/api/dev/tokens' });
  assertEqual(res.status, 200, 'on when asked for');
  assertEqual(res.body.tokens.length, 2, 'and it lists both kinds');

  const remote = await on.call(null, { method: 'GET', path: '/api/dev/tokens', loopback: false });
  assertEqual(remote.status, 404, 'and never off the loopback interface');
  return 'off by default, loopback only, never in a real deployment';
});

// ─────────────────────────── THE HOST ───────────────────────────
phase('The host — identity comes from the token, never the request');

// Every check here goes through host.handle(), which is the same code path the
// listening server uses. No socket, so the results are deterministic.
const hosted = () => {
  const w = world();
  onboard(w, manifest({ id: 'incident-desk', invocable: true, scope: { type: 'list', members: ['sarah', 'raj'] } }));
  onboard(w, manifest({ id: 'revenue-desk', connectors: [], scope: { type: 'list', members: ['sarah'] }, produces: ['metric'] }));
  enterpriseOutput(w, { id: 'rev_q4', agent: 'revenue-desk', subject: 'q4', value: 100 });
  enterpriseOutput(w, { id: 'inc_week', agent: 'incident-desk', kind: 'incident_summary', subject: 'api', value: { open: 3 } });
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });
  w.fleets.register({ fleet: 'f_raj', owner: 'raj', agents: [{ id: 'analyst' }] });
  const sarahToken = w.tokens.issue({ employee: 'sarah', fleet: 'f_sarah' }).token;
  const rajToken = w.tokens.issue({ employee: 'raj', fleet: 'f_raj' }).token;
  const call = (token, req) => w.host.handle({ ...req, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { w, sarahToken, rajToken, call };
};

await check('an unauthenticated request is refused and audited', async () => {
  const { w, call } = hosted();
  const none = await call(null, { method: 'GET', path: '/ledger/ask', query: { agent: 'analyst' } });
  assertEqual(none.status, 401, 'no token');
  const bogus = await call('ebt_nope', { method: 'GET', path: '/ledger/ask', query: { agent: 'analyst' } });
  assertEqual(bogus.status, 401, 'unknown token');
  assertEqual((await call(null, { method: 'GET', path: '/health' })).status, 200, 'health needs no token');
  assertEqual(w.audit.all().filter((e) => e.action === 'auth').length, 2, 'both refusals audited');
  return 'health open; everything else needs a live token';
});

await check('a body-supplied employee id is ignored, not honoured', async () => {
  const { call, sarahToken } = hosted();
  // Sarah's token, asking to be treated as raj. rev_q4 is sarah-only, so if the
  // body were honoured this read would be refused - and if it is ignored, allowed.
  const res = await call(sarahToken, {
    method: 'GET', path: '/ledger/outputs/rev_q4', query: { agent: 'analyst' },
    body: { employee: 'raj' },
  });
  assertEqual(res.status, 200, 'acted as sarah, the token holder');
  assertEqual(res.body.output.id, 'rev_q4', 'and read what sarah may read');

  // And the reverse: raj's token cannot reach sarah's output by claiming to be her.
  const { call: call2, rajToken } = hosted();
  const denied = await call2(rajToken, {
    method: 'GET', path: '/ledger/outputs/rev_q4', query: { agent: 'analyst' },
    body: { employee: 'sarah' },
  });
  assertEqual(denied.status, 403, 'claiming to be sarah changes nothing');
  return 'the employee field is not read; identity is the token';
});

await check('a body-supplied fleet id cannot be borrowed', async () => {
  const { call, rajToken } = hosted();
  // Raj claims to be acting as an agent inside sarah's fleet.
  const res = await call(rajToken, {
    method: 'POST', path: '/gateway/invoke',
    body: { via: { fleet: 'f_sarah', agent: 'analyst' }, target: 'incident-desk', op: 'incident.summary' },
  });
  // The fleet comes from the token, so this resolves to f_raj/analyst and fails on
  // f_raj's own missing grant - never on sarah's.
  assertEqual(res.status, 403, 'refused');
  assert(res.body.reason.includes('f_raj/analyst'), `resolved to the token's own fleet, got: ${res.body.reason}`);
  return res.body.reason;
});

await check('an unregistered agent id is refused before any access check', async () => {
  const { call, sarahToken } = hosted();
  const res = await call(sarahToken, { method: 'GET', path: '/ledger/ask', query: { agent: 'ghost' } });
  assertEqual(res.status, 403, 'refused');
  assert(res.body.reason.includes('not registered'), res.body.reason);
  return res.body.reason;
});

await check('publishing over the wire still computes the scope (D7)', async () => {
  const { call, sarahToken } = hosted();
  const res = await call(sarahToken, {
    method: 'POST', path: '/ledger/outputs',
    body: {
      via: { agent: 'analyst' },
      candidate: {
        id: 'note_1', kind: 'brief', body: { subject: 'ops', value: 'x' },
        derived_from: ['rev_q4'],
        scope: { type: 'org' },            // asked for org-wide
      },
    },
  });
  assertEqual(res.status, 201, JSON.stringify(res.body));
  assertEqual(res.body.scope, '1 named: sarah', 'the ledger overruled the request');
  return `${res.body.scope} — ${res.body.scope_basis}`;
});

await check('a published output is signed by the token holder, not the body', async () => {
  const { w, call, sarahToken } = hosted();
  await call(sarahToken, {
    method: 'POST', path: '/ledger/outputs',
    body: {
      via: { agent: 'analyst' },
      producer: { fleet: 'enterprise', agent: 'revenue-desk', identity: 'priya' },  // forged
      candidate: { id: 'note_2', kind: 'brief', body: { subject: 'ops', value: 'y' } },
    },
  });
  const o = w.ledger.get('note_2');
  assertEqual(o.producer, { fleet: 'f_sarah', agent: 'analyst', identity: 'sarah' }, 'producer is forced from the token');
  return 'a forged producer block is discarded';
});

await check('an approval cannot name someone else as the approver', async () => {
  const { w, call, sarahToken } = hosted();
  w.grants.issue({
    subject: { type: 'fleet_agent', fleet: 'f_sarah', agent: 'analyst' },
    agent: 'incident-desk', expires_at: soon(), approved_by: 'priya',
  });
  const res = await call(sarahToken, {
    method: 'POST', path: '/gateway/invoke',
    body: {
      via: { agent: 'analyst' }, target: 'incident-desk', op: 'incident.create',
      args: { short_description: 'x' },
      approval: { approved_by: 'priya' },   // trying to borrow an approver
    },
  });
  assertEqual(res.status, 200, 'the write went through as sarah approving her own agent');
  const row = w.audit.all().filter((e) => e.action === 'invoke').at(-1);
  assertEqual(row.detail.approved_by, 'sarah', 'audited as sarah, not priya');
  return 'the approver is always the caller';
});

await check('the board records the token holder as requester', async () => {
  const { w, call, sarahToken, rajToken } = hosted();
  const res = await call(sarahToken, {
    method: 'POST', path: '/board/items',
    body: { type: 'grant_request', subject: 'f_sarah/analyst -> incident-desk', requester: 'priya' },
  });
  assertEqual(res.status, 201, JSON.stringify(res.body));
  assertEqual(w.board.get(res.body.item.id).requester, 'sarah', 'requester forced from the token');

  // Status is scoped the same way: raj's own item is readable by raj and by nobody else.
  const rajItem = await call(rajToken, { method: 'POST', path: '/board/items', body: { type: 'grant_request', subject: 'x' } });
  const own = await call(rajToken, { method: 'GET', path: `/board/items/${rajItem.body.item.id}/status` });
  assertEqual(own.status, 200, 'raj reads his own');
  const theirs = await call(sarahToken, { method: 'GET', path: `/board/items/${rajItem.body.item.id}/status` });
  assertEqual(theirs.status, 404, 'sarah gets nothing for his item');
  return 'requester is the token holder, and status is scoped to them';
});

await check('a revoked token stops working immediately', async () => {
  const { w, call, sarahToken } = hosted();
  assertEqual((await call(sarahToken, { method: 'GET', path: '/ledger/ask', query: { agent: 'analyst' } })).status, 200, 'works first');
  w.tokens.revoke(sarahToken);
  assertEqual((await call(sarahToken, { method: 'GET', path: '/ledger/ask', query: { agent: 'analyst' } })).status, 401, 'and stops');
  return 'no cleanup job, no cache to expire';
});

await check('a live token for a former employee is refused', async () => {
  const { w, call } = hosted();
  const token = w.tokens.issue({ employee: 'dev', fleet: 'f_sarah' }).token;  // dev is 'former' in the directory
  const res = await call(token, { method: 'GET', path: '/ledger/ask', query: { agent: 'analyst' } });
  assertEqual(res.status, 403, 'refused on identity, not on the token');
  assert(res.body.reason.includes('not active'), res.body.reason);
  return 'offboarding takes effect at the host with nothing to revoke';
});

await check('an archived fleet cannot act', async () => {
  const { w, call, sarahToken } = hosted();
  w.fleets.archive('f_sarah', 'owner left');
  const res = await call(sarahToken, { method: 'GET', path: '/ledger/ask', query: { agent: 'analyst' } });
  assertEqual(res.status, 403, 'refused');
  assert(res.body.reason.includes('archived'), res.body.reason);
  return res.body.reason;
});

await check('an internal error never leaks a stack trace', async () => {
  const { w, call, sarahToken } = hosted();
  // Break a dependency the route relies on, then call it.
  w.query.ask = () => { throw new Error('secret internal detail at /platform/path'); };
  const res = await call(sarahToken, { method: 'GET', path: '/ledger/ask', query: { agent: 'analyst' } });
  assertEqual(res.status, 500, 'a 500, not a crash');
  assertEqual(res.body, { ok: false, reason: 'internal error' }, 'and nothing about the internals');
  return 'errors are opaque to the caller';
});

// ─────────────────────── Org model — a fleet states its own shape ───────────────────────
// Who reports to whom, and what each lane may and may not do, are declared at
// registration rather than inferred from an agent's name. The org chart renders
// exactly this. None of it touches an access decision.
phase('Org model — a fleet states its own shape');

const SHAPED = [
  {
    id: 'chief', purpose: 'triage and the brief', orchestrator: true, reports_to: 'sarah',
    can: ['Route work to the lane that owns it'], cannot: ['Send anything outward'],
  },
  {
    id: 'analyst', purpose: 'the numbers', reports_to: 'chief',
    can: ['Quote a figure with its basis'], cannot: ['Commit a date, scope or price'],
  },
];

await check('an agent registers with an orchestrator flag, a reporting line and its authority', () => {
  const w = world();
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: SHAPED });
  const f = w.fleets.get('f_sarah');
  const chief = f.agents.find((a) => a.id === 'chief');
  const analyst = f.agents.find((a) => a.id === 'analyst');
  assertEqual(chief.orchestrator, true, 'the orchestrator flag survives registration');
  assertEqual(chief.reports_to, 'sarah', 'the orchestrator reports to the owner');
  assertEqual(analyst.reports_to, 'chief', 'a specialist reports to the orchestrator');
  assertEqual(analyst.can, ['Quote a figure with its basis'], 'what the lane may do');
  assertEqual(analyst.cannot, ['Commit a date, scope or price'], 'and what it may not');
  return 'one orchestrator, one reporting line, authority stated on both lanes';
});

await check('the lane registry carries the shape through to the board', () => {
  const w = world();
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: SHAPED });
  const lanes = w.fleet('sarah', 'f_sarah').board.laneRegistry();
  assertEqual(lanes.chief.orchestrator, true, 'the board sees which lane is the orchestrator');
  assertEqual(lanes.analyst.reports_to, 'chief', 'and the reporting line');
  assertEqual(lanes.analyst.cannot, ['Commit a date, scope or price'], 'and the authority');
  return 'the org chart renders from the lane registry, so it renders from this';
});

await check('an agent registered without a shape gets safe defaults', () => {
  // The four fields are optional. Omitting them must not break a fleet.
  const w = world();
  w.fleets.register({ fleet: 'f_raj', owner: 'raj', agents: [{ id: 'solo', purpose: 'everything' }] });
  const a = w.fleets.get('f_raj').agents[0];
  assertEqual(a.orchestrator, false, 'no orchestrator claimed');
  assertEqual(a.reports_to, null, 'no reporting line claimed');
  assertEqual(a.can, [], 'no authority claimed');
  assertEqual(a.cannot, [], 'and no prohibition claimed');
  return 'undeclared is empty, never undefined — the chart degrades, it does not break';
});

await check('the shipped seed demonstrates the model it ships', async () => {
  // The quickstart is what an adopter runs first. If it does not declare a shape,
  // the org chart has nothing to draw and the feature may as well not exist.
  const { seedWorld, DIRECTORY: SEED_DIRECTORY } = await import('../seed.mjs');
  const w = world({ idp: SEED_DIRECTORY });
  await seedWorld(w, { baseUrl: 'http://localhost' });

  for (const f of w.fleets.all()) {
    const orchs = f.agents.filter((a) => a.orchestrator);
    assertEqual(orchs.length, 1, `${f.fleet} declares exactly one orchestrator`);
    assertEqual(orchs[0].reports_to, f.owner, `${f.fleet}'s orchestrator reports to its owner`);
    f.agents.filter((a) => !a.orchestrator).forEach((a) => {
      assertEqual(a.reports_to, orchs[0].id, `${f.fleet}/${a.id} reports to the orchestrator`);
    });
    f.agents.forEach((a) => {
      assert(a.can.length > 0, `${f.fleet}/${a.id} says what it can do`);
      assert(a.cannot.length > 0, `${f.fleet}/${a.id} says what it cannot do`);
    });
  }
  return `${w.fleets.all().length} seeded fleets, each with an orchestrator and authority on every lane`;
});

// ─────────────────────── ADVERSARIAL — cross-tenant integrity ───────────────────────
// Every check below was RED before the Track B fix it names. They are the attacks the
// original 74 did not think to try: an unvetted fleet reaching across the tenant boundary
// through a feature — supersede, derived_from, the scope lattice — that trusted its input.
phase('Adversarial — cross-tenant integrity');

// —— B1: supersedes is an owner-only operation ——
await check('B1 · an employee fleet cannot supersede an output it does not own', () => {
  const w = world();
  onboard(w, manifest({ id: 'fin', connectors: [], scope: { type: 'org' } }));
  w.fleets.register({ fleet: 'f_mallory', owner: 'sarah', agents: [{ id: 'scraper' }] });
  enterpriseOutput(w, { id: 'rev_q4', agent: 'fin', subject: 'q4', value: 1000 });

  const res = w.ledger.publish(newOutput({
    id: 'mallory_rev', kind: 'metric',
    producer: { fleet: 'f_mallory', agent: 'scraper', identity: 'sarah' },
    body: { subject: 'q4', value: 0 }, supersedes: 'rev_q4',
    sources: [{ system: 'gmail', harness: true }],
  }));
  assert(!res.ok, 'a cross-fleet supersede must be refused');
  assertEqual(w.ledger.freshnessOf('rev_q4'), 'fresh', 'the enterprise output must stay live');
  return res.reason;
});

await check('B1 · a refused supersede leaves the target and its descendants untouched', () => {
  const w = world();
  onboard(w, manifest({ id: 'fin', connectors: [], scope: { type: 'org' } }));
  w.fleets.register({ fleet: 'f_mallory', owner: 'sarah', agents: [{ id: 'scraper' }] });
  enterpriseOutput(w, { id: 'rev', agent: 'fin', subject: 'q4', value: 1000 });
  w.ledger.publish(newOutput({
    id: 'deck', kind: 'deck', producer: { fleet: 'enterprise', agent: 'fin', identity: 'priya' },
    body: { subject: 'q4', value: 'x' }, derived_from: ['rev'],
  }));
  w.ledger.publish(newOutput({
    id: 'attack', kind: 'metric', producer: { fleet: 'f_mallory', agent: 'scraper', identity: 'sarah' },
    body: { subject: 'q4', value: 0 }, supersedes: 'rev', sources: [{ system: 'gmail', harness: true }],
  }));
  assertEqual(w.ledger.freshnessOf('rev'), 'fresh', 'target untouched');
  assertEqual(w.ledger.freshnessOf('deck'), 'fresh', 'descendant untouched');
});

await check('B1 · a fleet may still supersede its OWN output (regression guard)', () => {
  const w = world();
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });
  w.ledger.publish(newOutput({
    id: 's1', kind: 'metric', producer: { fleet: 'f_sarah', agent: 'analyst', identity: 'sarah' },
    body: { subject: 'q4', value: 1 }, sources: [{ system: 'gmail', harness: true }],
  }));
  const res = w.ledger.publish(newOutput({
    id: 's2', kind: 'metric', producer: { fleet: 'f_sarah', agent: 'analyst', identity: 'sarah' },
    body: { subject: 'q4', value: 2 }, supersedes: 's1', sources: [{ system: 'gmail', harness: true }],
  }));
  assert(res.ok, 'a same-fleet supersede is legitimate: ' + (res.errors || []).join('; '));
  assertEqual(w.ledger.freshnessOf('s1'), 'stale', 'the fleet superseded its own output');
});

// —— B2: derived_from must be readable by the producer ——
await check('B2 · a fleet cannot derive from an output its producer cannot read', () => {
  const w = world();
  onboard(w, manifest({ id: 'hr', connectors: [], scope: { type: 'list', members: ['raj'] } }));
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'scraper' }] });
  enterpriseOutput(w, { id: 'raj_only', agent: 'hr', subject: 'comp', value: 42 });

  const res = w.ledger.publish(newOutput({
    id: 'sarah_leak', kind: 'metric',
    producer: { fleet: 'f_sarah', agent: 'scraper', identity: 'sarah' },
    body: { subject: 'comp', value: 'referenced' }, derived_from: ['raj_only'],
  }));
  assert(!res.ok, 'deriving from a parent the producer cannot read must be refused');
  return res.reason;
});

await check('B2 · deriving from a readable parent still works (regression guard)', () => {
  const w = world();
  onboard(w, manifest({ id: 'fin', connectors: [], scope: { type: 'org' } }));
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });
  enterpriseOutput(w, { id: 'pub', agent: 'fin', subject: 'q4', value: 1 });
  const res = w.ledger.publish(newOutput({
    id: 'derived_ok', kind: 'metric', producer: { fleet: 'f_sarah', agent: 'analyst', identity: 'sarah' },
    body: { subject: 'q4', value: 2 }, derived_from: ['pub'],
  }));
  assert(res.ok, 'an org-readable parent is a legitimate input: ' + (res.errors || []).join('; '));
});

// —— B3: the scope lattice does not widen on fleet ∩ list ——
await check('B3 · fleet ∩ list is nobody when the fleet owner is not on the list', () => {
  const ownerOf = (f) => ({ f_bob: 'bob' }[f] ?? null);
  const r = intersect(fleetScope('f_bob'), listScope(['carol']), { ownerOf });
  assertEqual(describe(r), 'nobody', 'bob is not on the list, so the intersection is empty');
});

await check('B3 · fleet ∩ list is the fleet when the owner IS on the list', () => {
  const ownerOf = (f) => ({ f_bob: 'bob' }[f] ?? null);
  const r = intersect(fleetScope('f_bob'), listScope(['bob', 'carol']), { ownerOf });
  assertEqual(describe(r), 'fleet-private (f_bob)', 'the owner is on the list, so the fleet survives');
});

await check('B3 · property: computed intersection audience == brute-force set intersection', () => {
  // The check that would have caught B3 on its own. For random scopes, the audience
  // intersectAll computes must equal the set of employees visible to EVERY input.
  const EMP = ['a', 'b', 'c', 'd'];
  const owners = { f_a: 'a', f_b: 'b' };
  const ownerOf = (f) => owners[f] ?? null;
  const pool = [
    { type: 'org' },
    listScope(['a', 'b']), listScope(['b', 'c']), listScope(['c', 'd']), listScope([]),
    fleetScope('f_a'), fleetScope('f_b'),
  ];
  const rand = (seed) => pool[seed % pool.length];
  let mismatches = 0;
  for (let i = 0; i < pool.length; i++) {
    for (let j = 0; j < pool.length; j++) {
      for (let k = 0; k < pool.length; k++) {
        const scopes = [rand(i), rand(j + 1), rand(k + 2)];
        const computed = intersectAll(scopes, { ownerOf });
        const computedAud = EMP.filter((e) => visibleTo(computed, e, ownerOf)).sort();
        const truth = EMP.filter((e) => scopes.every((s) => visibleTo(s, e, ownerOf))).sort();
        if (JSON.stringify(computedAud) !== JSON.stringify(truth)) mismatches += 1;
      }
    }
  }
  assertEqual(mismatches, 0, 'every computed audience matches the brute-force intersection');
  return `${pool.length ** 3} scope triples checked, 0 mismatches`;
});

// —— B4: hosted storage does not silently swallow a read failure ——
await check('B4 · a document backend surfaces a load failure instead of reporting empty', async () => {
  // The blob backend used to catch a read error and return { files: {} } — which the
  // next write then flushes back over live data. A failed load must propagate.
  const backend = createDocumentBackend({
    load: async () => { throw new Error('store unreachable'); },
    save: async () => {},
  });
  let threw = false;
  try { await backend.hydrate('platform'); } catch { threw = true; }
  assert(threw, 'a failed load must throw, never degrade to an empty document');
});

await check('B4 · two interleaved writers to one document do not silently lose an append', async () => {
  // Documents the lost-write hazard the hosted path is exposed to. With optimistic
  // concurrency, the second flush over a document that changed under it is rejected
  // rather than overwriting the first writer's append.
  const store = new Map();
  const mk = () => createDocumentBackend({
    load: async (n) => (store.has(n) ? JSON.parse(store.get(n)) : { files: {} }),
    save: async (n, doc) => { store.set(n, JSON.stringify(doc)); },
  });
  const A = mk(); const B = mk();
  await A.hydrate('platform'); await B.hydrate('platform');
  A.append('platform/ledger.jsonl', 'A\n');
  B.append('platform/ledger.jsonl', 'B\n');
  await A.flush();
  let conflict = false;
  try { await B.flush(); } catch { conflict = true; }
  assert(conflict, "B's stale flush must be rejected, not overwrite A's append");
});

// —— B5: unknown vendor ops are writes by default (approval required) ——
await check('B5 · a vendor op in neither reads nor writes requires human approval', () => {
  const w = world();
  onboard(w, manifest({ id: 'snow', invocable: true, scope: { type: 'list', members: ['sarah'] } }));
  w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst' }] });
  w.grants.issue({
    subject: { type: 'fleet_agent', fleet: 'f_sarah', agent: 'analyst' },
    agent: 'snow', expires_at: soon(), approved_by: 'priya',
  });
  // 'incident.escalate' is in neither the connector's reads nor its writes.
  const res = w.gateway.invoke({
    employee: 'sarah', via: { fleet: 'f_sarah', agent: 'analyst' },
    target: 'snow', op: 'incident.escalate', args: {},
  });
  assert(!res.ok && res.stage === 'approval_required',
    'an unclassified op must default to needing approval, not silently pass as a read');
  return res.reason;
});

process.exit(report() === 0 ? 0 : 1);
