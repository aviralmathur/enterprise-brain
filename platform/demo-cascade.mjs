// The one thing a wiki cannot do: correct an output, and everything derived from
// it goes stale by itself. Plus: a derived output's audience is COMPUTED from its
// inputs, never declared by its producer.
//
//   node demo-cascade.mjs
//
// Self-contained: it seeds a fresh fictional world through the real code paths,
// then drives the cascade and prints what the ledger decided. Nothing is mocked —
// every freshness value below is read back from the ledger after a real publish.
import { build } from './wire.mjs';
import { seedWorld, DIRECTORY } from './seed.mjs';
import { newOutput } from './brain/schema.mjs';
import { describe } from './brain/scope.mjs';

const w = build({ root: 'data/demo-cascade', fresh: true, idp: DIRECTORY });
await seedWorld(w);

const L = w.ledger;
const row = (id) => {
  const o = L.get(id);
  return `  ${id.padEnd(12)} ${describe(o.scope).padEnd(24)} ${L.freshnessOf(id)}`;
};
const rule = (s) => console.log(`\n${s}\n${'─'.repeat(s.length)}`);

rule('The provenance chain');
console.log('  recon_q3 is a reconciliation note the analyst published from two enterprise');
console.log('  figures that disagree:');
console.log('');
console.log('    rev_q3      (warehouse, audience: alice, bob, dave)');
console.log('    billing_q3  (billing,   audience: alice, bob)');
console.log('        └─ recon_q3  derived_from BOTH');

rule('1 · The audience was COMPUTED, not declared');
console.log('  The analyst never set recon_q3\'s scope. The ledger intersected its inputs:');
console.log('');
console.log('  id           audience                 freshness');
console.log(row('rev_q3'));
console.log(row('billing_q3'));
console.log(row('recon_q3'));
console.log('');
console.log('  → recon_q3 is visible to { alice, bob } — the INTERSECTION of its inputs,');
console.log('    the narrower two-person billing list, not the wider warehouse one.');
console.log('    Restricted data cannot be laundered into a wider audience by deriving from it.');

rule('2 · Correct one upstream figure — watch the cascade');
console.log('  The warehouse re-cuts Q3. revenue-desk publishes the correction, which');
console.log('  SUPERSEDES rev_q3 (an owner-only operation — only revenue-desk may do this):');
const res = L.correct('rev_q3', newOutput({
  id: 'rev_q3_v2',
  kind: 'metric',
  producer: { fleet: 'enterprise', agent: 'revenue-desk', identity: 'platform-ops' },
  body: { subject: 'q3_revenue', value: 4_210_000, unit: 'USD', period: 'Q3' },
  sources: [{ system: 'warehouse', ref: 'fct_revenue_recut' }],
  status: 'verified',
}));
console.log('');
console.log('  id           audience                 freshness');
console.log(row('rev_q3'));
console.log(row('recon_q3'));
console.log('');
console.log(`  → correcting rev_q3 invalidated everything derived from it: [${res.invalidated.join(', ')}]`);
console.log('    Nobody marked recon_q3 stale by hand. The derived_from edge did it.');
console.log('    That single property — the cascade — is what makes this a brain, not a wiki.');
console.log('');
