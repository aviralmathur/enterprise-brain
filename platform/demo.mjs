// End-to-end walkthrough, in the order the roadmap builds it.
// Run: node demo.mjs
import { build } from './wire.mjs';
import { newOutput } from './brain/schema.mjs';
import { scopeReview } from './platform-fleet/registry.mjs';
import { describe } from './brain/scope.mjs';

const line = (s = '') => console.log(s);
const step = (n, s) => { line(); line(`── ${n} ${'─'.repeat(Math.max(0, 66 - s.length - String(n).length))} ${s}`); };
const soon = () => new Date(Date.now() + 30 * 24 * 3600_000).toISOString();

const w = build({
  root: 'data/demo',
  fresh: true,
  idp: {
    employees: {
      sarah: { status: 'active', entitlements: ['finance.read', 'incidents.read'] },
      raj: { status: 'active', entitlements: ['incidents.read'] },
      priya: { status: 'active', entitlements: ['platform.admin'] },
    },
  },
});

step(1, 'Platform team onboards two enterprise agents');
for (const m of [
  {
    id: 'incident-desk', dri: 'priya', produces: ['incident_summary'], cadence: 'hourly',
    connectors: [{ system: 'servicenow', auth_mode: 'service_account' }],
    scope: { type: 'list', members: ['sarah', 'raj'] },
    invocable: true, rate_limit: { per_minute: 30 },
    quality_gate: 'incident_summary.check', deprecation_policy: '90d unused',
  },
  {
    id: 'revenue-desk', dri: 'priya', produces: ['metric'], cadence: 'daily',
    connectors: [], scope: { type: 'list', members: ['sarah'] },
    invocable: false, quality_gate: 'metric.nonnegative', deprecation_policy: '90d unused',
  },
]) {
  const review = scopeReview(m);
  const res = w.registry.publish(m, { reviewed_by: 'priya', review });
  line(`   ${m.id}: ${res.ok ? 'published v' + res.agent.version : 'REFUSED'} — access list ${JSON.stringify(w.registry.accessList(m.id))}`);
  for (const f of review.findings) line(`     ${f.severity}: ${f.finding}`);
}

step(2, 'A broad agent over a service account is refused, then re-scoped');
const bad = { id: 'snow-everything', dri: 'priya', produces: ['incident_summary'], connectors: [{ system: 'servicenow', auth_mode: 'service_account' }], scope: { type: 'org' }, invocable: false, quality_gate: 'x', deprecation_policy: '90d' };
let review = scopeReview(bad);
line(`   as org-wide: ${w.registry.publish(bad, { reviewed_by: 'priya', review }).ok ? 'published' : 'REFUSED — ' + review.findings[0].finding.slice(0, 72) + '…'}`);
const fixed = { ...bad, employee_reachable: false };
review = scopeReview(fixed);
line(`   as platform_internal: ${w.registry.publish(fixed, { reviewed_by: 'priya', review }).ok ? 'published' : 'refused'} — reachable by ${JSON.stringify(w.registry.accessList('snow-everything'))}`);

step(3, 'Enterprise agents publish typed outputs');
w.ledger.publish(newOutput({
  id: 'inc_week', kind: 'incident_summary', producer: { fleet: 'enterprise', agent: 'incident-desk', identity: 'priya' },
  body: { subject: 'payments-api', value: { open: 7, p1: 1 } },
  sources: [{ system: 'servicenow', ref: 'INC-QUERY' }], status: 'verified', ttl_seconds: 86400,
}));
w.ledger.publish(newOutput({
  id: 'rev_q4', kind: 'metric', producer: { fleet: 'enterprise', agent: 'revenue-desk', identity: 'priya' },
  body: { subject: 'q4', value: 4_180_000 },
  sources: [{ system: 'warehouse', ref: 'fct_revenue' }], status: 'verified',
}));
for (const id of ['inc_week', 'rev_q4']) {
  const o = w.ledger.get(id);
  line(`   ${id}: scope ${describe(o.scope)} — ${o.scope_basis}`);
}

step(4, 'Two employees ask the same question');
for (const who of ['sarah', 'raj']) {
  const res = w.query.ask(who, {});
  line(`   ${who} sees ${res.answers.length}: ${res.answers.map((a) => a.id).join(', ') || '(nothing)'}`);
}

step(5, 'Sarah stands up a fleet — no approval needed');
w.fleets.register({ fleet: 'f_sarah', owner: 'sarah', agents: [{ id: 'analyst', purpose: 'weekly ops read' }] });
line(`   f_sarah registered on harness "${w.fleets.get('f_sarah').harness}" with 1 agent`);

const f = w.fleet('sarah', 'f_sarah', { link: 'https://brain.corp/board' });
const board = f.board;

step(6, 'She is asked which tools she wants in the fleet');
const chosen = f.tools.choose('f_sarah', [
  { name: 'gmail', class: 'harness' },
  { name: 'jira', class: 'harness' },
  { name: 'incident-desk', class: 'enterprise' },
  { name: 'incident-desk', class: 'enterprise', invoke: true },
  { name: 'revenue-desk', class: 'enterprise' },
]);
for (const t of chosen.requested) {
  line(`   ${t.available ? 'ready  ' : 'pending'} ${t.name}${t.invoke ? ' (invoke)' : ''} — ${t.needs ?? t.why}`);
}
const conn = f.tools.connectionDescriptor({
  fleet: 'f_sarah',
  ledger_url: 'https://brain.corp/ledger',
  gateway_url: 'https://brain.corp/gateway',
  platform_board_url: 'https://brain.corp/board',
});
line(`   descriptor written to ${conn.path} — she points her harness at it`);

step(7, 'Her agent answers on the board — a proposal she can actually decide');
const item = board.instruct('sarah', 'combine the incident and revenue picture for the ops note', {
  lane: 'analyst', kind: 'task', tag: 'weekly ops',
}).item;
const proposed = board.propose(item.id, {
  agent: 'analyst',
  proposal: {
    understanding: 'One note covering incidents and revenue for the weekly ops read',
    actions: ['read both desks', 'derive one brief', 'publish it for the ops list'],
    needs: [],
    caution: 'will not restate a figure the ledger marks stale',
    source: 'agent',
  },
  candidate: {
    id: 'ops_note', kind: 'brief', body: { subject: 'weekly-ops', value: 'incidents up, revenue on plan' },
    derived_from: ['inc_week', 'rev_q4'],
    scope: { type: 'org' },          // the agent asks for org-wide
  },
});
line(`   understanding: ${proposed.entry.proposal.understanding}`);
line(`   will not: ${proposed.entry.proposal.caution}`);
line(`   preview before she signs: ${proposed.scope_preview.scope_label}` +
     `${proposed.scope_preview.overruled ? ' (narrower than the agent asked for)' : ''}`);

step(8, 'Her verdict is the publish — and the ledger computes the scope');
const pub = board.approve('sarah', item.id);
line(`   agent asked for: org-wide`);
line(`   ledger computed: ${describe(pub.output.scope)}`);
line(`   basis: ${pub.output.scope_basis}`);
line(`   thread: ${board.read(item.id).conversation.map((e) => e.kind).join(' -> ')}`);
line(`   → restricted data cannot be laundered into a wider audience`);

step(9, 'Raj cannot see the derived note; Sarah can');
for (const who of ['sarah', 'raj']) {
  const r = w.query.read(who, 'ops_note');
  line(`   ${who}: ${r.ok ? 'allowed' : 'refused — ' + r.reason}`);
}

step(10, 'Invoke without a grant is refused by the gateway');
let res = w.gateway.invoke({ employee: 'sarah', via: { fleet: 'f_sarah', agent: 'analyst' }, target: 'incident-desk', op: 'incident.summary' });
line(`   refused at stage "${res.stage}": ${res.reason}`);

step(11, 'She requests one; the platform team decides it');
const req = await board.requestGrant('sarah', { agent: 'analyst', target: 'incident-desk', justification: 'weekly ops note' });
line(`   platform queue: ${w.board.queue().length} open item`);
w.board.assign(req.platform_item, 'priya');
w.board.decide(req.platform_item, { decision: 'approved', by: 'priya', note: 'time-boxed 30d' });
w.grants.issue({ subject: { type: 'fleet_agent', fleet: 'f_sarah', agent: 'analyst' }, agent: 'incident-desk', expires_at: soon(), approved_by: 'priya', request_id: req.platform_item });
line(`   sarah sees on her own board: ${JSON.stringify(await board.grantStatus(req.item.id))}`);

step(12, 'Now the read invoke works — and a write still needs a human');
res = w.gateway.invoke({ employee: 'sarah', via: { fleet: 'f_sarah', agent: 'analyst' }, target: 'incident-desk', op: 'incident.summary' });
line(`   read:  ${res.ok ? 'allowed → published ' + res.published : 'refused'}`);
res = w.gateway.invoke({ employee: 'sarah', via: { fleet: 'f_sarah', agent: 'analyst' }, target: 'incident-desk', op: 'incident.create', args: { short_description: 'payments latency' } });
line(`   write: refused at stage "${res.stage}" — ${res.reason}`);
res = w.gateway.invoke({ employee: 'sarah', via: { fleet: 'f_sarah', agent: 'analyst' }, target: 'incident-desk', op: 'incident.create', args: { short_description: 'payments latency' }, approval: { approved_by: 'sarah' } });
line(`   write with approval: ${res.ok ? 'allowed → ' + res.result.receipt.body.value.number : 'refused'}`);

step(13, 'The revenue desk corrects itself — everything downstream goes stale');
line(`   before: ops_note is ${w.ledger.freshnessOf('ops_note')}`);
w.ledger.correct('rev_q4', newOutput({
  id: 'rev_q4_v2', kind: 'metric', producer: { fleet: 'enterprise', agent: 'revenue-desk', identity: 'priya' },
  body: { subject: 'q4', value: 3_910_000 }, sources: [{ system: 'warehouse', ref: 'fct_revenue' }], status: 'verified',
}));
line(`   after:  ops_note is ${w.ledger.freshnessOf('ops_note')} — ${w.ledger.get('ops_note').stale_reason}`);
line(`   → this is the difference between a brain and a wiki`);

step(14, 'A deletion request, honoured without breaking provenance');
const t = w.ledger.tombstone('inc_week', 'subject access request');
line(`   inc_week: ${w.ledger.get('inc_week').state}, body ${JSON.stringify(w.ledger.get('inc_week').body)}`);
line(`   cascaded to: ${t.cascaded.join(', ') || '(nothing further)'}`);

step(15, 'What governance can see');
const rows = w.audit.all();
line(`   ${rows.length} audit rows across ${new Set(rows.map((r) => r.action)).size} action types`);
for (const a of ['consume', 'invoke', 'grant', 'decision']) {
  const sub = rows.filter((r) => r.action === a);
  line(`     ${a.padEnd(9)} ${sub.length} (${sub.filter((r) => r.outcome === 'refused').length} refused)`);
}
line(`   Sarah's own board is not in here at all — drafts and rejections stay private (D10).`);
line();
line(`Data written to ${w.paths.root}/ — every file is plain text and readable.`);
line();
