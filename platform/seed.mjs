// A seeded world, built only through the real code paths.
//
// Nothing here writes a file directly: every output is published by the ledger,
// every scope is computed, every audit row is the by-product of an actual call.
// If an invariant were broken, seeding would break with it.
//
// The data is FICTIONAL on purpose. Alice, Bob, Carol and Dave are placeholder
// identities, the figures are invented, and no real person, system of record or
// internal number appears anywhere in this file. Point the connectors at real
// systems when you deploy it; do not put real people in the demo.
import { newOutput } from './brain/schema.mjs';
import { scopeReview } from './platform-fleet/registry.mjs';

export const DIRECTORY = {
  employees: {
    alice: { name: 'Alice', title: 'Revenue analyst', role: 'employee', status: 'active' },
    bob: { name: 'Bob', title: 'Finance manager', role: 'employee', status: 'active' },
    carol: { name: 'Carol', title: 'Operations', role: 'employee', status: 'active' },
    dave: { name: 'Dave', title: 'Controller', role: 'employee', status: 'active' },
    'platform-ops': { name: 'Platform Team', title: 'Enterprise Brain platform', role: 'platform_admin', status: 'active' },
  },
};

const MANIFESTS = [
  {
    id: 'revenue-desk',
    dri: 'platform-ops',
    produces: ['metric', 'metric_breakdown'],
    cadence: 'daily 07:00',
    connectors: [{ system: 'warehouse', auth_mode: 'service_account' }],
    scope: { type: 'list', members: ['alice', 'bob', 'dave'] },
    invocable: true,
    rate_limit: { per_minute: 30 },
    quality_gate: 'metric: numeric, non-negative, as_of within 7 days',
    deprecation_policy: '90d unused',
  },
  {
    id: 'incident-desk',
    dri: 'platform-ops',
    produces: ['incident_summary', 'incident_receipt'],
    cadence: 'hourly',
    connectors: [{ system: 'servicenow', auth_mode: 'service_account' }],
    scope: { type: 'list', members: ['alice', 'carol'] },
    invocable: true,
    rate_limit: { per_minute: 20 },
    quality_gate: 'incident_summary: open count present',
    deprecation_policy: '90d unused',
  },
  {
    id: 'people-desk',
    dri: 'platform-ops',
    produces: ['headcount'],
    cadence: 'weekly',
    // Delegated, so it acts as the caller and can be org-wide without handing
    // everyone a service account's reach.
    connectors: [{ system: 'people', auth_mode: 'delegated' }],
    scope: { type: 'org' },
    invocable: true,
    rate_limit: { per_minute: 10 },
    quality_gate: 'headcount: billable and bench present',
    deprecation_policy: '60d unused',
  },
  {
    id: 'billing-desk',
    dri: 'platform-ops',
    produces: ['metric'],
    cadence: 'daily',
    connectors: [],
    scope: { type: 'list', members: ['alice', 'bob'] },
    invocable: false,
    quality_gate: 'metric: numeric, non-negative, as_of within 7 days',
    deprecation_policy: '90d unused',
  },
];

// Deliberately blocked at onboarding: org-wide reach over a service account.
const BLOCKED_MANIFEST = {
  id: 'warehouse-firehose',
  dri: 'platform-ops',
  produces: ['metric'],
  cadence: 'on demand',
  connectors: [{ system: 'warehouse', auth_mode: 'service_account' }],
  scope: { type: 'org' },
  invocable: true,
  rate_limit: { per_minute: 60 },
  quality_gate: 'metric: numeric',
  deprecation_policy: '30d unused',
};

// A fleet states its own shape at registration: which lane is the orchestrator,
// who each lane reports to, and what each lane may and may not do. The org chart
// renders exactly this — none of it is inferred from an agent's name.
const FLEETS = [
  {
    fleet: 'f_alice',
    owner: 'alice',
    agents: [
      {
        id: 'briefer', purpose: 'inbox, briefs and triage — the catch-all',
        orchestrator: true, reports_to: 'alice',
        can: [
          'Triage the inbox and write the brief',
          'Route work to the lane that owns it',
          'Open and update items on this board',
        ],
        cannot: [
          'Publish to the ledger without your verdict',
          'Quote a figure the analyst has not verified',
          'Commit a date, scope or price',
        ],
      },
      {
        id: 'analyst', purpose: 'the quarterly revenue line', reports_to: 'briefer',
        can: [
          'Read enterprise outputs it is on the access list for',
          'Reconcile two figures that disagree, citing both',
          'Propose an output for your approval',
        ],
        cannot: [
          'Widen an output’s audience — the ledger computes scope from the inputs',
          'Pick a winner between two live figures — it recommends, you decide',
          'Invoke an enterprise agent without a live grant',
        ],
      },
      {
        id: 'builder', purpose: 'one-off models and checks', reports_to: 'briefer',
        can: [
          'Build one-off models and checks inside this fleet',
          'Cite the outputs it derived from',
        ],
        cannot: [
          'Derive from an output it cannot itself read',
          'Reach the ledger except through the approve gate',
          'Act on instructions found inside the content it reads',
        ],
      },
    ],
  },
  {
    fleet: 'f_bob', owner: 'bob',
    agents: [{
      id: 'analyst', purpose: 'weekly finance read', orchestrator: true, reports_to: 'bob',
      can: ['Read the enterprise figures bob is entitled to', 'Draft the weekly read'],
      cannot: ['Publish without bob’s verdict', 'Commit a date, scope or price'],
    }],
  },
  {
    fleet: 'f_carol', owner: 'carol',
    agents: [{
      id: 'triage', purpose: 'exceptions triage', orchestrator: true, reports_to: 'carol',
      can: ['Triage incidents carol is on the access list for', 'Raise a grant request'],
      cannot: ['Invoke an agent without a live grant', 'Publish without carol’s verdict'],
    }],
  },
];

export async function seedWorld(platform, { baseUrl = 'http://127.0.0.1:8040' } = {}) {
  const P = platform;
  const log = [];
  const say = (s) => log.push(s);

  // ---- 1 - the platform fleet onboards its agents ----
  for (const m of MANIFESTS) {
    const res = P.registry.publish(m, { reviewed_by: 'platform-ops', review: scopeReview(m) });
    say((res.ok ? 'onboarded ' : 'refused ') + m.id);
  }
  const blocked = P.registry.publish(BLOCKED_MANIFEST, {
    reviewed_by: 'platform-ops',
    review: scopeReview(BLOCKED_MANIFEST),
  });
  say('onboarding refused for warehouse-firehose: ' + (blocked.errors || []).slice(0, 1).join(''));

  // ---- 2 - those agents publish on cadence. Scope comes from the manifest ----
  const now = new Date().toISOString();
  const enterprise = [
    {
      id: 'rev_q3',
      kind: 'metric',
      agent: 'revenue-desk',
      body: { subject: 'q3_revenue', value: 4_180_000, unit: 'USD', period: 'Q3' },
      sources: [{ system: 'warehouse', ref: 'fct_revenue' }],
      ttl_seconds: 86_400,
    },
    {
      id: 'rev_q3_streams',
      kind: 'metric_breakdown',
      agent: 'revenue-desk',
      body: {
        subject: 'q3_revenue_by_stream',
        value: { new_business: 1_240_000, renewals: 2_010_000, services: 810_000, other: 120_000 },
      },
      sources: [{ system: 'warehouse', ref: 'fct_revenue_streams' }],
      ttl_seconds: 86_400,
    },
    {
      id: 'billing_q3',
      kind: 'metric',
      agent: 'billing-desk',
      // Same kind, same subject, a different number. A conflict the brain
      // surfaces and refuses to resolve on its own.
      body: { subject: 'q3_revenue', value: 4_062_000, unit: 'USD', period: 'Q3' },
      sources: [{ system: 'billing', ref: 'billing_export_09' }],
      ttl_seconds: 86_400,
    },
    {
      id: 'inc_week_payments',
      kind: 'incident_summary',
      agent: 'incident-desk',
      body: { subject: 'payments-api', value: { open: 7, p1: 1, trend: 'up' } },
      sources: [{ system: 'servicenow', ref: 'INC-QUERY' }],
      ttl_seconds: 3600,
    },
    {
      id: 'hc_q3',
      kind: 'headcount',
      agent: 'people-desk',
      body: { subject: 'all', value: { billable: 412, bench: 38, open_reqs: 17 } },
      sources: [{ system: 'people', ref: 'HRIS-ROLLUP' }],
      ttl_seconds: 43_200,
    },
  ];

  for (const e of enterprise) {
    const agent = P.registry.get(e.agent);
    const res = P.ledger.publish(
      newOutput({
        id: e.id,
        kind: e.kind,
        producer: { fleet: 'enterprise', agent: e.agent, identity: agent.dri },
        body: e.body,
        sources: e.sources,
        ttl_seconds: e.ttl_seconds,
        as_of: now,
      }),
    );
    say('published ' + e.id + ' at ' + (res.scope_label || 'error'));
  }
  // Status comes from a check that can fail. One kind has no gate and stays
  // unverified, which is the honest label rather than a silent pass.
  P.gates.runAll();

  // ---- 3 - employees stand up fleets. Nobody's permission is needed ----
  for (const f of FLEETS) {
    P.fleetRoster.register(f);
    say('registered ' + f.fleet + ' for ' + f.owner);
  }

  const tokens = {
    alice: P.tokens.issue({ kind: 'fleet', employee: 'alice', fleet: 'f_alice', days: 30, label: 'Alice fleet' }),
    bob: P.tokens.issue({ kind: 'fleet', employee: 'bob', fleet: 'f_bob', days: 30, label: 'Bob fleet' }),
    carol: P.tokens.issue({ kind: 'fleet', employee: 'carol', fleet: 'f_carol', days: 30, label: 'Carol fleet' }),
    platform: P.tokens.issue({ kind: 'platform', employee: 'platform-ops', days: 30, label: 'Platform team' }),
  };

  const A = P.fleetFor('alice', 'f_alice');
  const B = P.fleetFor('bob', 'f_bob');
  const C = P.fleetFor('carol', 'f_carol');

  // ---- 4 - tool selection, sorted by who has to say yes ----
  A.tools.choose('f_alice', [
    { name: 'mail', class: 'harness' },
    { name: 'chat', class: 'harness' },
    { name: 'files', class: 'harness' },
    { name: 'revenue-desk', class: 'enterprise' },
    { name: 'billing-desk', class: 'enterprise' },
    { name: 'incident-desk', class: 'enterprise', invoke: true, agent: 'analyst' },
    { name: 'people-desk', class: 'enterprise', invoke: true, agent: 'briefer' },
  ]);
  A.tools.connectionDescriptor({ fleet: 'f_alice', base_url: baseUrl });
  B.tools.choose('f_bob', [
    { name: 'mail', class: 'harness' },
    { name: 'revenue-desk', class: 'enterprise' },
    { name: 'incident-desk', class: 'enterprise' },
  ]);
  B.tools.connectionDescriptor({ fleet: 'f_bob', base_url: baseUrl });
  C.tools.choose('f_carol', [
    { name: 'mail', class: 'harness' },
    { name: 'revenue-desk', class: 'enterprise' },
  ]);

  // ---- 5 - an earlier grant request that was already decided ----
  const earlier = await A.board.raise('alice', {
    type: 'grant_request',
    agent: 'analyst',
    target: 'incident-desk',
    justification: 'weekly exceptions read for the Monday revenue note',
  });
  P.board.assign(earlier.platform_item, 'platform-ops');
  P.board.decide(earlier.platform_item, {
    decision: 'approved',
    by: 'platform-ops',
    note: 'time-boxed 14 days, read ops only',
  });
  // The decision's effect is applied by whoever owns the change, and named on
  // the item so the thread says what actually happened.
  const earlierGrant = P.grants.issue({
    subject: { type: 'fleet_agent', fleet: 'f_alice', agent: 'analyst' },
    agent: 'incident-desk',
    days: 14,
    approved_by: 'platform-ops',
    request_id: earlier.platform_item,
    justification: 'weekly exceptions read for the Monday revenue note',
  });
  await A.board.syncDecisions();
  say('grant issued to f_alice/analyst on incident-desk');

  // A grant that was issued and then pulled, so a revoked row is visible.
  const stale = P.grants.issue({
    subject: { type: 'fleet_agent', fleet: 'f_alice', agent: 'briefer' },
    agent: 'incident-desk',
    days: 30,
    approved_by: 'platform-ops',
    justification: 'brief automation, superseded',
  });
  P.grants.revoke(stale.grant.id, 'platform-ops');

  // ---- 6 - the fleet does its work, and the approve step publishes ----
  const item1 = A.board.instruct(
    'alice',
    'Reconcile the billing figure against the finance warehouse before the Monday revenue review.',
    { title: 'Reconcile billing against the warehouse', lane: 'analyst', kind: 'task', tag: 'quarter close' },
  ).item;
  A.board.propose(item1.id, {
    agent: 'analyst',
    proposal: {
      understanding: 'Two live figures for Q3 revenue disagree, and Monday needs one quotable line',
      actions: [
        'read both outputs and their provenance',
        'state both figures in the note, each cited to its producer',
        'recommend the warehouse line until billing is re-cut',
      ],
      needs: [],
      caution: 'will not pick a winner on the ledger: the note recommends, a person decides',
      source: 'agent',
    },
    candidate: {
      id: 'recon_q3',
      kind: 'note',
      body: {
        subject: 'q3_revenue_reconciliation',
        value: 'Warehouse 4.180M vs billing 4.062M for Q3. The 118k gap sits in services. The warehouse line is the quotable one until billing is re-cut.',
      },
      sources: [],
      derived_from: ['rev_q3', 'billing_q3'],
      ttl_seconds: 604_800,
    },
  });
  const approved = A.board.approve('alice', item1.id);
  say('verdict published ' + approved.published.id + ' at ' + approved.published.scope);
  A.board.report(item1.id, {
    agent: 'analyst',
    text: 'Published. The scope came back narrower than the warehouse list because the billing desk is a two-person list.',
  });

  // An item left waiting on the owner, so the approve gate can be seen working.
  // It declares org-wide and cites a harness source, so the ledger will floor it
  // at fleet-private no matter what the agent asked for.
  const item2 = A.board.instruct('alice', 'Draft the Monday revenue brief from my mail thread and the open incidents.', {
    title: 'Monday revenue brief', lane: 'briefer', kind: 'thread', tag: 'weekly',
  }).item;
  A.board.propose(item2.id, {
    agent: 'briefer',
    proposal: {
      understanding: 'One short brief for Monday, from my own mail and the open incidents',
      actions: ['read the mail thread', 'read the incident summary', 'draft three lines'],
      needs: ['a verdict before Monday 09:00'],
      caution: 'asked for org-wide so finance can all read it',
      source: 'agent',
    },
    candidate: {
      id: 'brief_q3',
      kind: 'note',
      body: {
        subject: 'monday_revenue_brief',
        value: 'Three items for Monday: the billing gap, the payments-api P1, and the renewals slip.',
      },
      sources: [{ system: 'mail', ref: 'thread-4821', harness: true }],
      derived_from: ['inc_week_payments'],
      scope: { type: 'org' },
      ttl_seconds: 604_800,
    },
  });

  // A third item still at instruct, and a rejected fourth, so the board has the
  // shape of real use rather than one happy path.
  A.board.instruct('alice', 'Pull the Q3 stream split and check services against last quarter.', {
    title: 'Q3 stream split check', lane: 'builder', kind: 'task', next: 'pull the split', status: 'blocked',
  });
  const item4 = A.board.instruct('alice', 'Publish the billing figure as the headline number for the week.', {
    title: 'Billing figure as headline', lane: 'analyst', kind: 'decision',
  }).item;
  A.board.propose(item4.id, {
    agent: 'analyst',
    proposal: {
      understanding: 'Make the billing figure the headline number for the week',
      actions: ['publish the billing total as the headline'],
      needs: [],
      caution: 'the two totals still disagree, so this may not be the right headline',
      source: 'agent',
    },
    candidate: {
      id: 'billing_headline',
      kind: 'note',
      body: { subject: 'headline_number', value: '4.062M' },
      sources: [],
      derived_from: ['billing_q3'],
    },
  });
  A.board.reject('alice', item4.id, 'Not while the two totals disagree. The reconciliation note is the deliverable.');

  // Three items that exist so the header's pressure signals are not all zero on
  // a fresh host. Each is a state a real board reaches on its own: something
  // dated that has come due, something whose ball is with somebody else, and
  // something nobody has touched in over a week.
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  A.board.add('alice', {
    title: 'Sign off the Q3 revenue note with finance',
    lane: 'analyst', kind: 'decision', status: 'waiting',
    waitingOn: 'finance review', due: today, tag: 'quarter close',
    next: 'chase the sign-off',
  });
  A.board.add('alice', {
    title: 'Retire the old stream mapping',
    lane: 'builder', kind: 'infra', status: 'blocked',
    next: 'confirm nothing still reads it',
    touched: daysAgo(11),
  });

  // A parked item and a moved field, so the board shows the whole vocabulary.
  const parked = A.board.add('alice', {
    title: 'Rebuild the quarterly model on the new stream split',
    lane: 'builder', kind: 'product', status: 'now', tag: 'quarter close',
    next: 'wait for the new split to land',
  }).item;
  A.board.park('alice', parked.id, 'blocked on the stream split, revisit next quarter');
  A.board.patch('alice', item1.id, { next: 'send the note to finance', waitingOn: null });

  // ---- 7 - the other two fleets, so the queue and the audit look real ----
  const bItem = B.board.instruct('bob', 'Track the quarterly total daily and flag any move over 100k.', {
    title: 'Daily revenue watch', lane: 'analyst', kind: 'infra', next: 'wait for the grant',
  }).item;
  B.board.report(bItem.id, { agent: 'analyst', text: 'Consume works. Invoke is refused: no grant on revenue-desk.' });
  const bReq = await B.board.raise('bob', {
    type: 'grant_request',
    agent: 'analyst',
    target: 'revenue-desk',
    justification: 'daily 07:15 read of the quarterly total, one call per day',
  });
  P.board.assign(bReq.platform_item, 'platform-ops');

  await C.board.raise('carol', {
    type: 'access_request',
    target: 'revenue-desk',
    justification: 'exceptions triage needs the revenue total to size each exception',
  });

  // A second fleet publishing its own root output. Built from her own files, so
  // the ledger floors it at her fleet however it was asked for.
  const cItem = C.board.instruct('carol', 'Log the weekly exceptions count for the triage handover.', {
    title: 'Weekly exceptions count', lane: 'triage', kind: 'task',
  }).item;
  C.board.propose(cItem.id, {
    agent: 'triage',
    proposal: {
      understanding: 'Log this week exceptions count so the handover has a number',
      actions: ['count the open exceptions', 'publish the count for the handover'],
      needs: [],
      caution: 'counted from my own files, so it stays inside my fleet',
      source: 'agent',
    },
    candidate: {
      id: 'carol_exceptions_wk37',
      kind: 'note',
      body: { subject: 'exceptions_count', value: 'Week 37: 41 exceptions, 6 unresolved for more than five days.' },
      sources: [{ system: 'files', ref: 'exceptions-wk37', harness: true }],
      derived_from: [],
    },
  });
  C.board.approve('carol', cItem.id);

  // ---- 8 - real traffic, so the audit trail and telemetry are not decoration ----
  const viaAnalyst = { fleet: 'f_alice', agent: 'analyst' };
  P.query.ask('alice', { kind: 'metric', subject: 'q3_revenue' }, viaAnalyst);
  P.query.read('alice', 'rev_q3', viaAnalyst);
  P.query.read('bob', 'rev_q3', { fleet: 'f_bob', agent: 'analyst' });
  // Refused: Carol is not on the revenue desk's access list. A refusal is
  // information, and it belongs in the trail.
  P.query.read('carol', 'rev_q3', { fleet: 'f_carol', agent: 'triage' });
  // Refused differently: Dave is on that access list but outside this output's
  // computed scope.
  P.query.read('dave', 'recon_q3', null);

  // A granted read invoke, then the same call from an agent with no grant.
  P.gateway.invoke({ employee: 'alice', via: viaAnalyst, target: 'incident-desk', op: 'incident.summary' });
  P.gateway.invoke({
    employee: 'alice',
    via: { fleet: 'f_alice', agent: 'briefer' },
    target: 'incident-desk',
    op: 'incident.summary',
  });
  // A write with no approval, refused at the gate. This is the break in the
  // chain that stops content an agent read from reaching a system of record.
  P.gateway.invoke({
    employee: 'alice',
    via: viaAnalyst,
    target: 'incident-desk',
    op: 'incident.create',
    args: { short_description: 'Revenue feed missing for Q3 day 8', assignment_group: 'finance-ops' },
  });
  P.gates.runAll();

  return {
    log,
    tokens: {
      alice: tokens.alice.token,
      bob: tokens.bob.token,
      carol: tokens.carol.token,
      platform: tokens.platform.token,
    },
    counts: {
      agents: P.registry.all().length,
      outputs: P.ledger.all().length,
      fleets: P.fleetRoster.all().length,
      queue_open: P.board.queue().length,
      audit: P.audit.all().length,
      conflicts: P.ledger.conflicts().length,
    },
  };
}
