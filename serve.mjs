// Start the host, so a fleet's harness has something to connect to.
//
//   node serve.mjs --seed            fresh world, agents onboarded, token printed
//   node serve.mjs                   serve whatever is already in the workspace
//   node serve.mjs --port 9000 --root ~/.enterprise-brain/platform
//
// This is the reference host: node:http, no dependencies, one process, file-backed.
// It is the piece a platform team replaces with the same routes on infrastructure
// they already run — the routes and the checks are what matter, not this process.
import { buildPlatform } from './wire.mjs';
import { platformWorkspace } from './workspace.mjs';
import { scopeReview } from './platform-fleet/registry.mjs';
import { newOutput } from './brain/schema.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};
const has = (name) => args.includes(`--${name}`);

const port = Number(flag('port', 8080));
const root = flag('root', 'data/serve');
const seed = has('seed');

const platform = buildPlatform({
  ws: platformWorkspace(root),
  fresh: seed,
  idp: seed
    ? {
      employees: {
        sarah: { status: 'active', entitlements: ['finance.read', 'incidents.read'] },
        raj: { status: 'active', entitlements: ['incidents.read'] },
        priya: { status: 'active', entitlements: ['platform.admin'] },
      },
    }
    : null,
});

let issued = null;

if (seed) {
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
    platform.registry.publish(m, { reviewed_by: 'priya', review: scopeReview(m) });
  }

  platform.ledger.publish(newOutput({
    id: 'inc_week', kind: 'incident_summary',
    producer: { fleet: 'enterprise', agent: 'incident-desk', identity: 'priya' },
    body: { subject: 'payments-api', value: { open: 7, p1: 1 } },
    sources: [{ system: 'servicenow', ref: 'INC-QUERY' }], status: 'verified', ttl_seconds: 86400,
  }));
  platform.ledger.publish(newOutput({
    id: 'rev_q4', kind: 'metric',
    producer: { fleet: 'enterprise', agent: 'revenue-desk', identity: 'priya' },
    body: { subject: 'q4', value: 4_180_000 },
    sources: [{ system: 'warehouse', ref: 'fct_revenue' }], status: 'verified',
  }));

  platform.fleetRoster.register({
    fleet: 'f_sarah', owner: 'sarah',
    agents: [{ id: 'analyst', purpose: 'weekly ops read' }],
  });

  issued = platform.tokens.issue({
    employee: 'sarah', fleet: 'f_sarah',
    expires_at: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
  });
}

const { url } = await platform.host.listen(port, '127.0.0.1');

console.log('');
console.log(`Enterprise Brain host listening on ${url}`);
console.log(`  workspace   ${platform.paths.root}`);
console.log(`  agents      ${platform.registry.all().map((a) => a.id).join(', ') || '(none onboarded)'}`);
console.log(`  outputs     ${platform.ledger.all().length}`);
console.log('');
console.log('Endpoints for a connection descriptor:');
console.log(`  ledger          ${url}/ledger`);
console.log(`  gateway         ${url}/gateway`);
console.log(`  platform_board  ${url}/board`);
console.log('');

if (issued) {
  console.log(`Fleet token for ${issued.employee} / ${issued.fleet}:`);
  console.log(`  ${issued.token}`);
  console.log('');
  console.log('Try it — identity comes from the token, so no employee id is ever sent:');
  console.log('');
  console.log(`  curl -s "${url}/ledger/ask?agent=analyst" \\`);
  console.log(`    -H "authorization: Bearer ${issued.token}"`);
  console.log('');
  console.log(`  curl -s "${url}/ledger/outputs/rev_q4?agent=analyst" \\`);
  console.log(`    -H "authorization: Bearer ${issued.token}"`);
  console.log('');
  console.log('  # refused: no grant for this agent on incident-desk');
  console.log(`  curl -s -X POST "${url}/gateway/invoke" \\`);
  console.log(`    -H "authorization: Bearer ${issued.token}" -H "content-type: application/json" \\`);
  console.log(`    -d '{"via":{"agent":"analyst"},"target":"incident-desk","op":"incident.summary"}'`);
  console.log('');
  console.log('  # raise a grant request onto the platform team\'s board');
  console.log(`  curl -s -X POST "${url}/board/items" \\`);
  console.log(`    -H "authorization: Bearer ${issued.token}" -H "content-type: application/json" \\`);
  console.log(`    -d '{"type":"grant_request","subject":"f_sarah/analyst -> incident-desk"}'`);
  console.log('');
}

console.log('Ctrl+C to stop.');
