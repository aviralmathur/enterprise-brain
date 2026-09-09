// Platform Mission Control - the platform team's review desk (D19).
//
// A DIFFERENT product from the employee fleet board (D9), not the same component
// instanced twice. What differs is the item, not the grammar:
//
//   fleet board      my own work,          I own the item,   a verdict authorises me
//   platform board   someone else's ask,   a team owns it,   a decision changes a grant
//
// What is deliberately shared is the *thread*: the same append-only entries in
// the same six kinds, from brain/board.mjs. One vocabulary, two boards. Somebody
// who can read one can read the other, which was not true when each invented its
// own states.
//
// The item lifecycle stays its own - open, in_review, closed - because a queue
// is not a work board and "In flight" says nothing useful about a request.
//
// Ships THIN, per D19: items, assignee, decision, audit record. Deliberately
// absent until Phase 6: SLAs, standing recurring reviews, conflict adjudication.
import { readDoc, writeDoc } from '../brain/store.mjs';
import { makeEntry, append, thread, conversation, lastMovement } from '../brain/board.mjs';

export const ITEM_TYPES = ['agent_onboarding', 'grant_request', 'access_request', 'deprecation'];
export const STATES = ['open', 'in_review', 'closed'];

const EMPTY = { items: {}, seq: 0, revision: 0 };

export class PlatformBoard {
  constructor(path, audit) {
    this.path = path;
    this.audit = audit;
  }

  load() {
    return readDoc(this.path, EMPTY);
  }

  save(db) {
    db.revision = (db.revision || 0) + 1;
    db.updated_at = new Date().toISOString();
    writeDoc(this.path, db);
    return db;
  }

  // Anyone may raise an item; only the platform team decides one. This is the
  // only write a fleet can make on this side.
  submit({ type, subject, requester, payload }) {
    if (!ITEM_TYPES.includes(type)) return { ok: false, errors: ['type must be one of ' + ITEM_TYPES.join('|')] };
    if (!requester) return { ok: false, errors: ['requester is required'] };

    const db = this.load();
    db.seq += 1;
    const id = 'item_' + String(db.seq).padStart(4, '0');
    const item = {
      id,
      type,
      subject: subject || null,
      requester,
      payload: payload || {},
      state: 'open',
      assignee: null,
      decision: null,
      decided_by: null,
      decided_at: null,
      note: null,
      effect: null,
      submitted_at: new Date().toISOString(),
      thread: [],
    };
    // The request itself is the first turn, so the thread is complete from the
    // start rather than beginning at the first review comment.
    db.items[id] = append(item, makeEntry(id, 'instruction', requester, subject || type));
    this.save(db);
    return { ok: true, item: db.items[id] };
  }

  assign(id, assignee) {
    const db = this.load();
    const item = db.items[id];
    if (!item) return { ok: false, errors: ['no such item'] };
    if (item.state === 'closed') return { ok: false, errors: ['item is closed'] };
    if (!assignee) return { ok: false, errors: ['an assignment needs a named reviewer'] };

    const moved = { ...item, assignee, state: 'in_review' };
    db.items[id] = append(moved, makeEntry(id, 'change', 'system', 'Assigned to ' + assignee));
    this.save(db);
    return { ok: true, item: db.items[id] };
  }

  // A reviewer thinking out loud on the record. Not a decision.
  comment(by, id, text) {
    const db = this.load();
    const item = db.items[id];
    if (!item) return { ok: false, errors: ['no such item'] };
    if (!text) return { ok: false, errors: ['a comment needs text'] };
    db.items[id] = append(item, makeEntry(id, 'note', by || 'platform', text));
    this.save(db);
    return { ok: true, item: db.items[id] };
  }

  // A decision is an audit record. That is the whole difference from a task
  // board: an item here does not record an opinion, it changes something, and
  // the change is attributable afterwards.
  //
  // `effect` is set by the caller that applied the change (a grant issued, an
  // access list widened), so the thread says what actually happened rather than
  // what was intended.
  decide(id, { decision, by, note, effect = null }) {
    const db = this.load();
    const item = db.items[id];
    if (!item) return { ok: false, errors: ['no such item'] };
    if (!['approved', 'rejected'].includes(decision)) return { ok: false, errors: ['decision must be approved or rejected'] };
    if (!by) return { ok: false, errors: ['a decision needs a named decider'] };
    if (item.state === 'closed') return { ok: false, errors: ['this item is already decided'] };

    const decided = {
      ...item,
      decision,
      decided_by: by,
      decided_at: new Date().toISOString(),
      note: note || null,
      effect,
      state: 'closed',
    };
    db.items[id] = append(
      decided,
      makeEntry(id, 'decision', by, note || '', { verdict: decision, ...(effect ? { effect } : {}) }),
    );
    this.save(db);

    this.audit.record({
      action: 'decision',
      employee: by,
      target: id,
      outcome: decision === 'approved' ? 'allowed' : 'refused',
      reason: note || null,
      detail: { type: item.type, subject: item.subject, requester: item.requester, effect },
    });
    return { ok: true, item: db.items[id] };
  }

  get(id) {
    return this.load().items[id] || null;
  }

  all() {
    return Object.values(this.load().items).sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1));
  }

  queue() {
    return this.all().filter((i) => i.state !== 'closed');
  }

  // Unassigned and open: what a reviewer picks up next.
  unassigned() {
    return this.queue().filter((i) => !i.assignee);
  }

  mine(reviewer) {
    return this.queue().filter((i) => i.assignee === reviewer);
  }

  revision() {
    return this.load().revision || 0;
  }

  read(id) {
    const item = this.get(id);
    if (!item) return null;
    return {
      item,
      conversation: conversation(item),
      changes: thread(item).filter((e) => e.kind === 'change'),
      last: lastMovement(item),
    };
  }

  // The requester sees the status of their OWN item and nothing else (D18).
  // There is no route that lists this queue to a fleet, so it cannot be walked.
  statusFor(requester, id) {
    const item = this.get(id);
    if (!item || item.requester !== requester) return { ok: false, reason: 'not your item' };
    return {
      ok: true,
      id: item.id,
      state: item.state,
      decision: item.decision,
      decided_at: item.decided_at,
      note: item.note,
      effect: item.effect,
    };
  }
}
