// The enterprise agent registry. Owned by the platform team (D1).
// Enforces the scoping standard (D6) at onboarding, which is where vendor
// entitlement questions are settled once rather than per request (D5).
import { readDoc, writeDoc } from '../brain/store.mjs';

export const AUTH_MODES = ['delegated', 'service_account'];

export function validateManifest(m) {
  const errs = [];
  const need = (k) => { if (!m[k]) errs.push(`${k} is required`); };
  need('id'); need('dri'); need('scope');
  if (!Array.isArray(m.produces) || !m.produces.length) errs.push('produces must list at least one output kind');
  if (!m.quality_gate) errs.push('quality_gate is required - status must come from a runnable check, not a claim');
  if (!m.deprecation_policy) errs.push('deprecation_policy is required');
  for (const c of m.connectors ?? []) {
    if (!c.system) errs.push('every connector needs a system');
    if (!AUTH_MODES.includes(c.auth_mode)) errs.push(`connector ${c.system}: auth_mode must be ${AUTH_MODES.join('|')}`);
  }
  if (m.invocable && !m.rate_limit?.per_minute) errs.push('an invocable agent needs rate_limit.per_minute');
  if (m.scope && !['org', 'list'].includes(m.scope.type)) errs.push('manifest scope must be org or list');
  if (m.scope?.type === 'list' && !Array.isArray(m.scope.members)) errs.push('a list scope needs members');
  return errs;
}

// D6: an agent whose reach cannot be scoped narrowly does not get exposed to
// employee fleets. Its outputs are published instead.
export function scopeReview(m) {
  const findings = [];
  const svc = (m.connectors ?? []).filter((c) => c.auth_mode === 'service_account');
  const broad = m.scope?.type === 'org';

  if (svc.length && broad && m.employee_reachable !== false) {
    findings.push({
      severity: 'blocking',
      finding: `org-wide scope over service-account connector(s) ${svc.map((c) => c.system).join(', ')}: every employee on the access list would see everything that account can see`,
      remedy: 'narrow the scope to a named list, or mark the agent platform_internal and publish its outputs instead',
    });
  }
  if (svc.length && !broad && m.employee_reachable !== false) {
    findings.push({
      severity: 'advisory',
      finding: `service-account connector(s) ${svc.map((c) => c.system).join(', ')} sit behind a named-list scope`,
      remedy: 'permission creep on this connector silently widens that list - put it on the standing review',
    });
  }
  return { blocking: findings.some((f) => f.severity === 'blocking'), findings };
}

export class Registry {
  constructor(path) { this.path = path; }

  load() { return readDoc(this.path, { agents: {} }); }
  save(db) { writeDoc(this.path, db); }

  publish(manifest, { reviewed_by, review }) {
    const errs = validateManifest(manifest);
    if (errs.length) return { ok: false, errors: errs };
    if (!reviewed_by) return { ok: false, errors: ['a manifest may only be published with a recorded reviewer'] };
    if (review?.blocking) {
      return { ok: false, errors: ['scope review is blocking', ...review.findings.map((f) => f.finding)] };
    }

    const db = this.load();
    const prev = db.agents[manifest.id];
    db.agents[manifest.id] = {
      ...manifest,
      version: (prev?.version ?? 0) + 1,
      lifecycle: 'published',
      reviewed_by,
      review_findings: review?.findings ?? [],
      published_at: new Date().toISOString(),
    };
    this.save(db);
    return { ok: true, agent: db.agents[manifest.id] };
  }

  get(id) { return this.load().agents[id] ?? null; }
  all() { return Object.values(this.load().agents); }
  isEnterpriseAgent(id) { return Boolean(this.get(id)); }

  declaredScopeOf(id) {
    const a = this.get(id);
    if (!a || a.lifecycle === 'retired') return null;
    return a.scope;
  }

  // Who may reach this agent at all (D5). A platform_internal agent is reachable by nobody.
  accessList(id) {
    const a = this.get(id);
    if (!a || a.lifecycle === 'retired') return [];
    if (a.employee_reachable === false) return [];
    if (a.scope.type === 'org') return 'org';
    return a.scope.members;
  }

  isInvocable(id) {
    const a = this.get(id);
    return Boolean(a && a.lifecycle === 'published' && a.invocable);
  }

  rateLimit(id) { return this.get(id)?.rate_limit?.per_minute ?? 0; }

  setLifecycle(id, lifecycle) {
    const db = this.load();
    if (!db.agents[id]) return { ok: false, errors: ['no such agent'] };
    db.agents[id].lifecycle = lifecycle;
    db.agents[id].lifecycle_at = new Date().toISOString();
    this.save(db);
    return { ok: true, agent: db.agents[id] };
  }

  // Retiring an agent must mark its outputs stale - which is why the registry
  // ships after the ledger, not before.
  retire(id, ledger) {
    const res = this.setLifecycle(id, 'retired');
    if (!res.ok) return res;
    const affected = ledger.all().filter((o) => o.producer.agent === id && o.state === 'live');
    for (const o of affected) ledger.tombstone(o.id, `producing agent ${id} was retired`);
    return { ok: true, retired: id, outputs_marked: affected.map((o) => o.id) };
  }
}
