// The IAM seam. D14/kill-risk-2: the brain stores NO entitlements — it resolves
// them on every call through this provider. Swapping the local provider for a
// real IdP is a config change, not a rewrite.
import { readDoc } from './store.mjs';

// A provider must implement: resolve(employeeId) -> { id, status, entitlements: [] }
export function createLocalProvider(path) {
  return {
    name: 'local-directory',
    resolve(employeeId) {
      // Read every time. No cache, deliberately: a stale cache is a permissions bug.
      const dir = readDoc(path, { employees: {} });
      const rec = dir.employees[employeeId];
      if (!rec) return { id: employeeId, status: 'unknown', entitlements: [] };
      return { id: employeeId, status: rec.status ?? 'active', entitlements: rec.entitlements ?? [] };
    },
  };
}

export function isActive(provider, employeeId) {
  return provider.resolve(employeeId).status === 'active';
}

// Used by the acceptance suite to prove the invariant rather than assert it.
export function assertNoStoredEntitlements(records) {
  const offenders = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'entitlements') offenders.push(`${path}.${k}`);
      walk(v, `${path}.${k}`);
    }
  };
  records.forEach((r, i) => walk(r, `[${i}]`));
  return offenders;
}
