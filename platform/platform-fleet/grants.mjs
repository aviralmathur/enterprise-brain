// Invoke grants. Issued centrally by the platform team (D4), always time-boxed,
// to an employee OR to a named agent inside a named fleet.
import { readDoc, writeDoc } from '../brain/store.mjs';

export const subjectKey = (s) =>
  s.type === 'employee' ? `employee:${s.id}` : `fleet_agent:${s.fleet}/${s.agent}`;

export class Grants {
  constructor(path, audit) { this.path = path; this.audit = audit; }

  load() { return readDoc(this.path, { grants: {} }); }
  save(db) { writeDoc(this.path, db); }

  issue({ subject, agent, expires_at, approved_by, request_id = null }) {
    if (!subject || !agent) return { ok: false, errors: ['subject and agent are required'] };
    if (!approved_by) return { ok: false, errors: ['a grant needs a recorded approver'] };
    if (!expires_at) return { ok: false, errors: ['a grant must be time-boxed'] };
    if (Date.parse(expires_at) <= Date.now()) return { ok: false, errors: ['expires_at is already in the past'] };

    const db = this.load();
    const id = `grant_${subjectKey(subject).replace(/[^a-z0-9]/gi, '_')}_${agent}`;
    db.grants[id] = {
      id, subject, agent, expires_at, approved_by, request_id,
      issued_at: new Date().toISOString(), revoked: false,
    };
    this.save(db);
    this.audit?.record({
      action: 'grant',
      employee: subject.type === 'employee' ? subject.id : null,
      target: agent, outcome: 'allowed',
      detail: { grant: id, subject: subjectKey(subject), approved_by, expires_at },
    });
    return { ok: true, grant: db.grants[id] };
  }

  revoke(id, by) {
    const db = this.load();
    if (!db.grants[id]) return { ok: false, errors: ['no such grant'] };
    db.grants[id].revoked = true;
    db.grants[id].revoked_by = by;
    db.grants[id].revoked_at = new Date().toISOString();
    this.save(db);
    this.audit?.record({
      action: 'grant', employee: null, target: db.grants[id].agent,
      outcome: 'refused', reason: 'revoked', detail: { grant: id, by },
    });
    return { ok: true };
  }

  // A grant may sit with the calling agent, or with the employee directly.
  find({ employee, via, agent }) {
    const db = this.load();
    const keys = [subjectKey({ type: 'employee', id: employee })];
    if (via) keys.push(subjectKey({ type: 'fleet_agent', fleet: via.fleet, agent: via.agent }));
    const hit = Object.values(db.grants).find(
      (g) => g.agent === agent
        && !g.revoked
        && keys.includes(subjectKey(g.subject))
        && Date.parse(g.expires_at) > Date.now(),
    );
    return hit ?? null;
  }

  all() { return Object.values(this.load().grants); }
}
