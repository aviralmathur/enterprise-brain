// Fleet Mission Control - the employee's private single-operator cockpit (D9).
// Thread shape is fixed by the platform: instruct -> propose -> approve -> report.
//
// The approve step IS the publish gate (D8/D9). It is the only path by which
// anything an employee's fleet produced reaches the shared ledger, and the
// employee is the accountable signer.
//
// Private by D10: the platform team cannot read this board. Drafts and rejected
// proposals are visible to nobody but the owner.
import { readDoc, writeDoc } from '../brain/store.mjs';
import { newOutput } from '../brain/schema.mjs';
import { describe } from '../brain/scope.mjs';

export class FleetBoard {
  constructor(path, { fleet, owner, ledger, platformBoard = null }) {
    this.path = path;
    this.fleet = fleet;
    this.owner = owner;
    this.ledger = ledger;
    this.platformBoard = platformBoard;
  }

  load() { return readDoc(this.path, { items: {}, seq: 0 }); }
  save(db) { writeDoc(this.path, db); }

  assertOwner(actor) {
    if (actor !== this.owner) return { ok: false, errors: [`this board belongs to ${this.owner}`] };
    return { ok: true };
  }

  // 1. instruct
  instruct(actor, text) {
    const guard = this.assertOwner(actor);
    if (!guard.ok) return guard;
    const db = this.load();
    db.seq += 1;
    const id = `fi_${String(db.seq).padStart(4, '0')}`;
    db.items[id] = {
      id, fleet: this.fleet, state: 'instructed',
      thread: [{ at: new Date().toISOString(), by: actor, as: 'owner', kind: 'instruct', text }],
      proposal: null, published: null, grant_request: null,
    };
    this.save(db);
    return { ok: true, item: db.items[id] };
  }

  // 2. propose - an agent puts up a candidate output. Nothing has left the fleet yet.
  propose(id, { agent, candidate, note }) {
    const db = this.load();
    const item = db.items[id];
    if (!item) return { ok: false, errors: ['no such item'] };
    item.proposal = { agent, candidate, note: note ?? null, at: new Date().toISOString() };
    item.state = 'proposed';
    item.thread.push({ at: new Date().toISOString(), by: agent, as: 'agent', kind: 'propose', text: note ?? 'candidate output ready' });
    this.save(db);
    return { ok: true, item };
  }

  // 3. approve == publish. The ledger still computes the scope (D7); approving
  //    does not widen anything, it only lets the output through the gate.
  approve(actor, id) {
    const guard = this.assertOwner(actor);
    if (!guard.ok) return guard;
    const db = this.load();
    const item = db.items[id];
    if (!item) return { ok: false, errors: ['no such item'] };
    if (!item.proposal) return { ok: false, errors: ['nothing proposed to approve'] };

    const p = item.proposal;
    const res = this.ledger.publish(newOutput({
      ...p.candidate,
      producer: { fleet: this.fleet, agent: p.agent, identity: this.owner },
    }));
    if (!res.ok) return { ok: false, errors: res.errors };

    item.state = 'published';
    item.published = { id: res.output.id, scope: describe(res.output.scope), basis: res.scope_basis, at: new Date().toISOString() };
    item.thread.push({
      at: new Date().toISOString(), by: actor, as: 'owner', kind: 'approve',
      text: `published ${res.output.id} at scope ${describe(res.output.scope)} (${res.scope_basis})`,
    });
    this.save(db);
    return { ok: true, item, output: res.output };
  }

  reject(actor, id, why) {
    const guard = this.assertOwner(actor);
    if (!guard.ok) return guard;
    const db = this.load();
    const item = db.items[id];
    if (!item) return { ok: false, errors: ['no such item'] };
    item.state = 'rejected';
    item.thread.push({ at: new Date().toISOString(), by: actor, as: 'owner', kind: 'reject', text: why ?? 'rejected' });
    this.save(db);
    return { ok: true, item };
  }

  // 4. report back
  report(id, { agent, text }) {
    const db = this.load();
    const item = db.items[id];
    if (!item) return { ok: false, errors: ['no such item'] };
    item.thread.push({ at: new Date().toISOString(), by: agent, as: 'agent', kind: 'report', text });
    this.save(db);
    return { ok: true, item };
  }

  // The one coupling to the platform board (D18): a request leaves, a status returns.
  requestGrant(actor, { agent, target, justification }) {
    const guard = this.assertOwner(actor);
    if (!guard.ok) return guard;
    if (!this.platformBoard) return { ok: false, errors: ['no platform board wired'] };

    const sub = this.platformBoard.submit({
      type: 'grant_request',
      subject: `${this.fleet}/${agent} -> ${target}`,
      requester: this.owner,
      payload: { subject: { type: 'fleet_agent', fleet: this.fleet, agent }, agent: target, justification },
    });
    if (!sub.ok) return sub;

    const db = this.load();
    db.seq += 1;
    const id = `fi_${String(db.seq).padStart(4, '0')}`;
    db.items[id] = {
      id, fleet: this.fleet, state: 'awaiting_grant',
      thread: [{ at: new Date().toISOString(), by: actor, as: 'owner', kind: 'instruct', text: `requested invoke on ${target}` }],
      proposal: null, published: null, grant_request: sub.item.id,
    };
    this.save(db);
    return { ok: true, item: db.items[id], platform_item: sub.item.id };
  }

  // Status only - the employee never sees the platform queue (D18).
  grantStatus(id) {
    const item = this.get(id);
    if (!item?.grant_request) return { ok: false, reason: 'no grant request on this item' };
    return this.platformBoard.statusFor(this.owner, item.grant_request);
  }

  get(id) { return this.load().items[id] ?? null; }
  all() { return Object.values(this.load().items); }
}
