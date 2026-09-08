// The roadmap's exit tests, as runnable checks.
// Each check names the phase or decision it proves. A phase that cannot pass its
// check has not shipped, whatever the code says.
import { existsSync, readdirSync } from 'node:fs';
import { readLines, readDoc } from '../brain/store.mjs';
import { newOutput } from '../brain/schema.mjs';
import { assertNoStoredEntitlements } from '../brain/identity.mjs';
import { describe } from '../brain/scope.mjs';
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
  assertEqual(Object.keys(item).sort(), [
    'assignee', 'decided_at', 'decided_by', 'decision', 'id', 'note',
    'payload', 'requester', 'state', 'subject', 'submitted_at', 'type',
  ], 'no SLA or standing-review fields yet — those are Phase 6');

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

process.exit(report() === 0 ? 0 : 1);
