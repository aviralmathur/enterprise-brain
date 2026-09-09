// A dependency-free test harness. Each case gets a fresh data root so cases
// cannot contaminate one another.
import { join } from 'node:path';
import { build } from '../wire.mjs';
import { newOutput } from '../brain/schema.mjs';
import { scopeReview } from '../platform-fleet/registry.mjs';

export const DIRECTORY = {
  employees: {
    sarah: { status: 'active', entitlements: ['finance.read', 'incidents.read'] },
    raj: { status: 'active', entitlements: ['incidents.read'] },
    priya: { status: 'active', entitlements: ['platform.admin'] },
    dev: { status: 'former', entitlements: [] },
  },
};

let n = 0;
// `devTokens` is the only host option a check needs to vary: it decides whether
// the local token list is served, and that is a rule worth proving both ways.
export function world({ devTokens = false } = {}) {
  n += 1;
  return build({ root: join('data', `case-${n}`), fresh: true, idp: structuredClone(DIRECTORY), devTokens });
}

// Onboard an enterprise agent the way the platform team would: manifest + review.
export function onboard(w, manifest, reviewer = 'priya') {
  const review = scopeReview(manifest);
  return { review, result: w.registry.publish(manifest, { reviewed_by: reviewer, review }) };
}

export function manifest(over = {}) {
  return {
    id: 'incident-summary',
    dri: 'priya',
    produces: ['incident_summary'],
    cadence: 'hourly',
    connectors: [{ system: 'servicenow', auth_mode: 'service_account' }],
    scope: { type: 'list', members: ['sarah', 'raj'] },
    invocable: false,
    rate_limit: { per_minute: 10 },
    quality_gate: 'incident_summary.check',
    deprecation_policy: '90d unused',
    ...over,
  };
}

// Publish a root output as an onboarded enterprise agent.
export function enterpriseOutput(w, { id, agent, kind = 'metric', subject, value, sources }) {
  return w.ledger.publish(newOutput({
    id, kind,
    producer: { fleet: 'enterprise', agent, identity: 'priya' },
    body: { subject, value },
    sources: sources ?? [{ system: 'warehouse', ref: `q:${id}`, harness: false }],
    status: 'verified',
  }));
}

// ——— assertions ———
const results = [];
let currentPhase = 'general';

export function phase(name) { currentPhase = name; }

export async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ phase: currentPhase, name, pass: true, detail: detail ?? null });
  } catch (err) {
    results.push({ phase: currentPhase, name, pass: false, detail: err.message });
  }
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? 'assertion failed');
  return true;
}

export function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? 'not equal'} — expected ${e}, got ${a}`);
  return true;
}

export function report() {
  const byPhase = new Map();
  for (const r of results) {
    if (!byPhase.has(r.phase)) byPhase.set(r.phase, []);
    byPhase.get(r.phase).push(r);
  }

  let failed = 0;
  const lines = [];
  for (const [ph, rows] of byPhase) {
    lines.push('');
    lines.push(`  ${ph}`);
    for (const r of rows) {
      if (!r.pass) failed += 1;
      const mark = r.pass ? 'PASS' : 'FAIL';
      lines.push(`    [${mark}] ${r.name}`);
      if (r.detail && (!r.pass || typeof r.detail === 'string')) lines.push(`           ${r.detail}`);
    }
  }
  lines.push('');
  lines.push(`  ${results.length - failed}/${results.length} checks passed`);
  console.log(lines.join('\n'));
  return failed;
}
