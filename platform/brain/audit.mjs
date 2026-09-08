// Append-only audit of everything crossing the fleet boundary (D10).
// Harness-connector activity never reaches here — it is audited by the system of record.
import { appendLine, readLines } from './store.mjs';

export class Audit {
  constructor(path) { this.path = path; }

  record(event) {
    const entry = {
      at: new Date().toISOString(),
      action: event.action,          // 'consume' | 'invoke' | 'publish' | 'grant' | 'decision' | 'refuse'
      employee: event.employee,      // on whose behalf
      via: event.via ?? null,        // { fleet, agent } that acted
      target: event.target ?? null,  // output id, agent id, grant id
      outcome: event.outcome,        // 'allowed' | 'refused'
      reason: event.reason ?? null,
      ...(event.detail ? { detail: event.detail } : {}),
    };
    appendLine(this.path, entry);
    return entry;
  }

  all() { return readLines(this.path); }

  for(employeeId) { return this.all().filter((e) => e.employee === employeeId); }

  refusals() { return this.all().filter((e) => e.outcome === 'refused'); }
}
