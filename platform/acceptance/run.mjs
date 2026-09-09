// The roadmap's exit tests, as runnable checks.
// Each check names the phase or decision it proves. A phase that cannot pass its
// check has not shipped, whatever the code says.
import { existsSync, readdirSync } from 'node:fs';
import { readLines, readDoc } from '../brain/store.mjs';
import { newOutput } from '../brain/schema.mjs';
import { assertNoStoredEntitlements } from '../brain/identity.mjs';
import { describe } from '../brain/scope.mjs';
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

process.exit(report() === 0 ? 0 : 1);
