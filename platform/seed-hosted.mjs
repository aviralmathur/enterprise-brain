// Seed a HOSTED brain, from your machine, over the same storage the deployment
// reads.
//
//   BLOB_READ_WRITE_TOKEN=... node seed-hosted.mjs
//
// A serverless function cannot seed itself: `serve.mjs --seed` builds a world on
// a disk that a deployment does not have. So this runs the same seed locally,
// against the Blob store the deployment uses, and prints the tokens it minted.
// Those tokens are the only way into a hosted board, because the local token
// list is off on a deployment.
//
// It REPLACES what is there. Run it once when you stand a deployment up, and
// again only when you want the world back to its seeded state.
import { buildPlatform } from './wire.mjs';
import { platformWorkspace } from './workspace.mjs';
import { setBackend } from './brain/store.mjs';
import { createBlobBackend, blobConfigured, documentsFor } from './brain/blob-store.mjs';
import { seedWorld, DIRECTORY } from './seed.mjs';

// The same root the function uses, so it writes the same documents.
const ROOT = 'data/hosted';

if (!blobConfigured()) {
  console.error('');
  console.error('No BLOB_READ_WRITE_TOKEN in the environment.');
  console.error('');
  console.error('Create a Blob store on your own Vercel account, then either');
  console.error('  vercel env pull .env.local     # and source it');
  console.error('or paste the token into this command for one run.');
  console.error('');
  process.exit(2);
}

const base = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'https://your-deployment.vercel.app';

const backend = setBackend(createBlobBackend());

// Every document this seed touches, hydrated before anything is built. The
// employees come from the seed's own directory, so this stays correct if that
// directory changes.
const employees = Object.keys(DIRECTORY.employees);
await backend.hydrate(['platform', ...employees.map((e) => `workspaces/${e}`)]);

const platform = buildPlatform({
  ws: platformWorkspace(`${ROOT}/platform`),
  workspaceRoot: `${ROOT}/workspaces`,
  idp: DIRECTORY,
  devTokens: false,
});

const seeded = await seedWorld(platform, { baseUrl: base });
const written = await backend.flush();

console.log('');
console.log('Seeded the hosted brain.');
console.log(`  documents written  ${written.join(', ')}`);
console.log(`  counts             ${JSON.stringify(seeded.counts)}`);
console.log('');
console.log('Tokens. These are the only way into a hosted board, so keep them');
console.log('somewhere safe and hand each one to its own person:');
for (const [who, token] of Object.entries(seeded.tokens)) {
  console.log(`  ${who.padEnd(10)}${token}`);
}
console.log('');
console.log('Open a board already signed in:');
console.log(`  ${base}/fleet#token=${seeded.tokens.alice}`);
console.log(`  ${base}/platform#token=${seeded.tokens.platform}`);
console.log('');
console.log('The token travels in the URL fragment, which never reaches the server.');
console.log('');
