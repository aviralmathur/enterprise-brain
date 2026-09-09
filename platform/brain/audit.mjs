// Append-only audit of everything crossing the fleet boundary (D10).
// Harness-connector activity never reaches here — it is audited by the system of record.
import { appendLine, readLines } from './store.mjs';

export class Audit {
  constructor(path) { this.path = path; }

  record(event) {
    const entry = {
      at: new Date().toISOString(),
      action: event.action,          // 'consume' | 'invoke' | 'publish' | 'grant' | 'decision' | 'auth' | 'lifecycle'
      employee: event.employee,      // on whose behalf
      via: event.via ?? null,        // { fleet, agent } that acted
      target: event.target ?? null,  // output id, agent id, grant id
      outcome: event.outcome,        // 'allowed' | 'refused'
      reason: event.reason ?? null,
      // The stage a refusal failed at: identity, registry, access_list, grant,
      // rate_limit, load_shed, approval_required. Absent when nothing was refused.
      ...(event.stage ? { stage: event.stage } : {}),
      ...(event.detail ? { detail: event.detail } : {}),
    };
    appendLine(this.path, entry);
    return entry;
  }

  all() { return readLines(this.path); }

  for(employeeId) { return this.all().filter((e) => e.employee === employeeId); }

  refusals() { return this.all().filter((e) => e.outcome === 'refused'); }

  // Newest first, and filterable, because the only useful way to read a trail
  // this long is to narrow it first.
  recent(limit = 100, filter = {}) {
    let rows = this.all();
    if (filter.action) rows = rows.filter((e) => e.action === filter.action);
    if (filter.employee) rows = rows.filter((e) => e.employee === filter.employee);
    if (filter.outcome) rows = rows.filter((e) => e.outcome === filter.outcome);
    return rows.slice(-limit).reverse();
  }

  // Counts per action with the refusals called out separately. A trail where
  // nothing was ever refused is a trail nobody should trust.
  summary() {
    const byAction = {};
    for (const e of this.all()) {
      byAction[e.action] = byAction[e.action] ?? { total: 0, refused: 0 };
      byAction[e.action].total += 1;
      if (e.outcome === 'refused') byAction[e.action].refused += 1;
    }
    return byAction;
  }
}
