// Start the host: the two Mission Controls, the API behind them, and the three
// endpoints a connection descriptor names.
//
//   node serve.mjs --seed            fresh world, both boards, tokens printed
//   node serve.mjs                   serve whatever is already in the workspace
//   node serve.mjs --port 9000 --root data/other
//
// This is the reference host: node:http, no dependencies, one process,
// file-backed. It is the piece a platform team replaces with the same routes on
// infrastructure they already run. The routes and the checks are what matter,
// not this process.
import { buildPlatform } from './wire.mjs';
import { platformWorkspace } from './workspace.mjs';
import { seedWorld, DIRECTORY } from './seed.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};
const has = (name) => args.includes(`--${name}`);

const port = Number(flag('port', 8080));
const host = flag('host', '127.0.0.1');
const root = flag('root', 'data/serve');
const seed = has('seed');
// The landing page can hand out local tokens only when the host was started for
// a local demo. Off by default, loopback only, and never for a real deployment.
const devTokens = seed || has('dev-tokens');

const platform = buildPlatform({
  ws: platformWorkspace(`${root}/platform`),
  workspaceRoot: `${root}/workspaces`,
  fresh: seed,
  idp: seed ? DIRECTORY : null,
  devTokens,
});

let seeded = null;
if (seed) seeded = await seedWorld(platform, { baseUrl: `http://${host}:${port}` });

const { url } = await platform.host.listen(port, host);

console.log('');
console.log(`Enterprise Brain  ${url}`);
console.log(`  workspace        ${platform.paths.root}`);
console.log(`  agents           ${platform.registry.all().map((a) => a.id).join(', ') || '(none onboarded)'}`);
console.log(`  outputs          ${platform.ledger.all().length}`);
console.log(`  fleets           ${platform.fleetRoster.all().map((f) => f.fleet).join(', ') || '(none)'}`);
console.log('');
console.log('Mission Control');
console.log(`  employee fleet   ${url}/fleet`);
console.log(`  platform fleet   ${url}/platform`);
console.log(`  landing          ${url}/`);
console.log('');
console.log('Endpoints a connection descriptor names');
console.log(`  ledger           ${url}/ledger`);
console.log(`  gateway          ${url}/gateway`);
console.log(`  platform_board   ${url}/board`);
console.log('');

if (seeded) {
  console.log(`Seeded: ${JSON.stringify(seeded.counts)}`);
  console.log('');
  console.log('Tokens (local demo only):');
  for (const [who, token] of Object.entries(seeded.tokens)) {
    console.log(`  ${who.padEnd(10)}${token}`);
  }
  console.log('');
  console.log('Open a board already signed in:');
  console.log(`  ${url}/fleet#token=${seeded.tokens.alice}`);
  console.log(`  ${url}/platform#token=${seeded.tokens.platform}`);
  console.log('');
  console.log('Or reach it without a browser, identity from the token:');
  console.log('');
  console.log(`  curl -s "${url}/ledger/ask?agent=analyst" \\`);
  console.log(`    -H "authorization: Bearer ${seeded.tokens.alice}"`);
  console.log('');
}

console.log('Ctrl+C to stop.');
