// Platform Mission Control - THIN, per D19.
// Phase 3 scope: items, assignee, decision, audit record. Nothing else.
// Deliberately absent until Phase 6: SLAs, standing recurring reviews, conflict
// adjudication. Those are specified from what the team was actually doing by hand.
//
// This is a DIFFERENT product from the employee fleet board (D9), not the same
// component instanced twice: multi-reviewer, subject is someone else's request,
// and every decision is an audit record.
import { readDoc, writeDoc } from '../brain/store.mjs';

export const ITEM_TYPES = ['agent_onboarding', 'grant_request', 'deprecation'];

export class PlatformBoard {
  constructor(path, audit) { this.path = path; this.audit = audit; }

  load() { return readDoc(this.path, { items: {}, seq: 0 }); }
  save(db) { writeDoc(this.path, db); }

  // Anyone may raise an item; only the platform team decides one.
  submit({ type, subject, requester, payload }) {
    if (!ITEM_TYPES.includes(type)) return { ok: false, errors: [`type must be one of ${ITEM_TYPES.join('|')}`] };
    if (!requester) return { ok: false, errors: ['requester is required'] };

    const db = this.load();
    db.seq += 1;
    const id = `item_${String(db.seq).padStart(4, '0')}`;
    db.items[id] = {
      id, type, subject, requester, payload: payload ?? {},
      state: 'open', assignee: null,
      decision: null, decided_by: null, decided_at: null, note: null,
      submitted_at: new Date().toISOString(),
    };
    this.save(db);
    return { ok: true, item: db.items[id] };
  }

  assign(id, assignee) {
    const db = this.load();
    const item = db.items[id];
    if (!item) return { ok: false, errors: ['no such item'] };
    if (item.state !== 'open') return { ok: false, errors: [`item is ${item.state}`] };
    item.assignee = assignee;
    item.state = 'in_review';
    this.save(db);
    return { ok: true, item };
  }

  // A decision is an audit record. That is the whole difference from a task board.
  decide(id, { decision, by, note }) {
    const db = this.load();
    const item = db.items[id];
    if (!item) return { ok: false, errors: ['no such item'] };
    if (!['approved', 'rejected'].includes(decision)) return { ok: false, errors: ['decision must be approved or rejected'] };
    if (!by) return { ok: false, errors: ['a decision needs a named decider'] };

    item.decision = decision;
    item.decided_by = by;
    item.decided_at = new Date().toISOString();
    item.note = note ?? null;
    item.state = 'closed';
    this.save(db);

    this.audit.record({
      action: 'decision', employee: by, target: id, outcome: decision === 'approved' ? 'allowed' : 'refused',
      reason: note ?? null, detail: { type: item.type, subject: item.subject, requester: item.requester },
    });
    return { ok: true, item };
  }

  get(id) { return this.load().items[id] ?? null; }
  all() { return Object.values(this.load().items); }
  queue() { return this.all().filter((i) => i.state !== 'closed'); }

  // The employee sees the status of their OWN item and nothing else (D18).
  statusFor(requester, id) {
    const item = this.get(id);
    if (!item || item.requester !== requester) return { ok: false, reason: 'not your item' };
    return { ok: true, state: item.state, decision: item.decision, decided_at: item.decided_at, note: item.note };
  }
}
