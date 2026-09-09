// Fleet Mission Control - one employee's private cockpit (D9).
//
// The structure is the one that survives contact with real use: items in lanes,
// a work status per item, and an append-only thread per item. The vocabulary
// lives in brain/board.mjs so the platform queue speaks it too.
//
//   instruction  ->  proposal  ->  decision  ->  report
//     (owner)        (agent)       (owner)      (agent)
//
// Two properties are worth stating before the code.
//
// **A verdict authorises; it does not execute.** Approving a plan records
// approved intent, and the agent carries it out in its own next session and
// posts a report on the same thread. That is how a board stays honest about the
// difference between "I said yes" and "it happened".
//
// **The exception is an output.** When a proposal carries a candidate output,
// approving it IS the publish action (D8/D9) - it is the only path by which
// anything an employee's fleet produced reaches the shared ledger, and the
// employee is the accountable signer. The board still writes the report entry,
// so the thread reads the same way either way.
//
// Private by D10: the platform team cannot read this board. Drafts, rejected
// proposals and half-formed instructions stay here.
import { readDoc, writeDoc } from '../brain/store.mjs';
import { newOutput } from '../brain/schema.mjs';
import { describe } from '../brain/scope.mjs';
import {
  STATUSES,
  STATUS_ORDER,
  KINDS,
  VERDICTS,
  isClosed,
  lanes as makeLanes,
  newItem,
  validateItem,
  validateProposal,
  makeEntry,
  append,
  thread,
  conversation,
  lastMovement,
  describeChange,
  pending,
  awaitingAgent,
  allProposals,
  instructionFor,
  byStatus,
  byLane,
  PATCH_FIELDS,
} from '../brain/board.mjs';

const EMPTY = { items: {}, seq: 0, revision: 0 };

export class FleetBoard {
  constructor(path, { fleet, owner, ledger, platformLink = null, roster = null, laneRegistry = null }) {
    this.path = path;
    this.fleet = fleet;
    this.owner = owner;
    this.ledger = ledger;
    this.platformLink = platformLink;
    this.roster = roster;
    // Lanes default to the fleet's registered agents, so the board's lanes and
    // the fleet's addressable agents cannot drift apart.
    this.lanes = laneRegistry || makeLanes(this.#lanesFromRoster());
  }

  #lanesFromRoster() {
    if (!this.roster) return null;
    const f = this.roster.get(this.fleet);
    if (!f) return null;
    const reg = {};
    for (const a of f.agents) reg[a.id] = { name: a.id, role: a.purpose || 'agent in this fleet' };
    return reg;
  }

  load() {
    return readDoc(this.path, EMPTY);
  }

  // Every write bumps the revision, so a stale client can tell it is behind
  // rather than overwriting what it never saw.
  save(db) {
    db.revision = (db.revision || 0) + 1;
    db.updated_at = new Date().toISOString();
    writeDoc(this.path, db);
    return db;
  }

  #assertOwner(actor) {
    if (actor !== this.owner) return { ok: false, errors: ['this board belongs to ' + this.owner] };
    return { ok: true };
  }

  #assertLane(lane) {
    if (!lane || lane === 'owner') return { ok: true };
    if (!this.lanes.has(lane)) return { ok: false, errors: ['unknown lane: ' + lane] };
    return { ok: true };
  }

  #nextId(db) {
    db.seq += 1;
    return 'fi_' + String(db.seq).padStart(4, '0');
  }

  // ---- create an item ----
  //
  // `add` is the plain form. `instruct` is the common one: create the item and
  // post the first instruction in one call, because an item with no ask on it is
  // just a title.
  add(actor, { title, lane = 'owner', kind = 'task', status = 'now', tag, next, waitingOn, due, note, links, confidential }) {
    const guard = this.#assertOwner(actor);
    if (!guard.ok) return guard;
    const laneGuard = this.#assertLane(lane);
    if (!laneGuard.ok) return laneGuard;

    const db = this.load();
    const id = this.#nextId(db);
    const item = newItem({ id, title, lane, kind, status, tag, next, waitingOn, due, note, links, confidential });
    const errs = validateItem(item, this.lanes);
    if (errs.length) return { ok: false, errors: errs };

    db.items[id] = item;
    this.save(db);
    return { ok: true, item };
  }

  instruct(actor, text, opts = {}) {
    const guard = this.#assertOwner(actor);
    if (!guard.ok) return guard;
    if (!text) return { ok: false, errors: ['an instruction needs text'] };

    const created = this.add(actor, {
      title: opts.title || String(text).slice(0, 72),
      lane: opts.lane || 'owner',
      kind: opts.kind || 'task',
      status: opts.status || 'now',
      tag: opts.tag,
      next: opts.next,
      waitingOn: opts.waitingOn,
      due: opts.due,
      confidential: opts.confidential,
    });
    if (!created.ok) return created;

    return this.post(actor, created.item.id, 'instruction', text);
  }

  // ---- post a turn onto an existing item ----
  //
  // Only three kinds may be posted by hand. `proposal` comes from an agent
  // through propose(), `decision` from decide(), and `change` is written by the
  // board itself - a hand-written change entry would be a lie about what
  // happened.
  post(actor, itemId, kind, body, extra = {}) {
    if (!['instruction', 'note', 'report'].includes(kind)) {
      return { ok: false, errors: ['only instruction, note or report may be posted by hand'] };
    }
    const db = this.load();
    const item = db.items[itemId];
    if (!item) return { ok: false, errors: ['no such item'] };

    // An instruction or a note is the owner's. A report is the lane's, because
    // the agent is the one reporting.
    const author = kind === 'report' ? extra.agent || item.lane : this.owner;
    if (kind !== 'report') {
      const guard = this.#assertOwner(actor);
      if (!guard.ok) return guard;
    }
    if (!body) return { ok: false, errors: [kind + ' needs a body'] };

    const entry = makeEntry(itemId, kind, author, body, extra.replyTo ? { replyTo: extra.replyTo } : {});
    db.items[itemId] = append(item, entry);
    this.save(db);
    return { ok: true, item: db.items[itemId], entry };
  }

  // Kept because a report is the most common turn an agent posts.
  report(itemId, { agent, text }) {
    const db = this.load();
    const item = db.items[itemId];
    if (!item) return { ok: false, errors: ['no such item'] };
    const guard = this.#assertLane(agent);
    if (!guard.ok) return guard;
    return this.post(this.owner, itemId, 'report', text, { agent: agent || item.lane });
  }

  note(actor, itemId, text) {
    return this.post(actor, itemId, 'note', text);
  }

  // ---- change a field, and log the change ----
  patch(actor, itemId, patchFields) {
    const guard = this.#assertOwner(actor);
    if (!guard.ok) return guard;
    const db = this.load();
    const item = db.items[itemId];
    if (!item) return { ok: false, errors: ['no such item'] };

    const clean = {};
    for (const key of Object.keys(PATCH_FIELDS)) if (key in patchFields) clean[key] = patchFields[key];
    if (clean.status && !STATUSES[clean.status]) {
      return { ok: false, errors: ['status must be one of ' + STATUS_ORDER.join('|')] };
    }

    const described = describeChange(item, clean);
    if (!described) return { ok: true, item, unchanged: true };

    const moved = { ...item, ...clean };
    db.items[itemId] = append(moved, makeEntry(itemId, 'change', 'system', described));
    this.save(db);
    return { ok: true, item: db.items[itemId], change: described };
  }

  // ---- an agent answers ----
  //
  // The proposal is structured on purpose: understanding, actions, needs, and
  // what the agent will deliberately not do. A candidate output is optional -
  // most proposals are a plan, and only some produce something publishable.
  propose(itemId, { agent, proposal, candidate = null, note = null }) {
    const db = this.load();
    const item = db.items[itemId];
    if (!item) return { ok: false, errors: ['no such item'] };

    const lane = agent || item.lane;
    const laneGuard = this.#assertLane(lane);
    if (!laneGuard.ok) return laneGuard;

    // A bare note used to be enough. It is accepted and lifted into the
    // structured shape, so an old caller still works and the thread still holds
    // something answerable.
    const shaped = proposal || {
      understanding: note || (candidate ? 'publish ' + (candidate.id || 'this output') : 'proceed'),
      actions: candidate ? ['publish the candidate output through the approve gate'] : ['proceed as instructed'],
      needs: [],
      caution: null,
      source: 'agent',
    };
    const errs = validateProposal(shaped);
    if (errs.length) return { ok: false, errors: errs };

    let withProducer = null;
    let preview = null;
    if (candidate) {
      withProducer = {
        ...candidate,
        id: candidate.id || this.fleet + '_' + itemId.replace('fi_', 'out'),
        producer: { fleet: this.fleet, agent: lane, identity: this.owner },
      };
      // Show the audience before anyone signs. This writes nothing.
      preview = this.ledger.previewScope
        ? this.ledger.previewScope(withProducer)
        : { ok: true, scope_label: 'computed at publish' };
    }

    // A proposal answers the newest unanswered instruction, when there is one.
    const open = thread(item)
      .filter((e) => e.kind === 'instruction')
      .filter((e) => !thread(item).some((x) => x.kind === 'proposal' && x.replyTo === e.id));
    const replyTo = open.length ? open[open.length - 1].id : undefined;

    const entry = makeEntry(itemId, 'proposal', lane, shaped.understanding, {
      proposal: shaped,
      ...(replyTo ? { replyTo } : {}),
      ...(withProducer ? { candidate: withProducer, scope_preview: preview } : {}),
    });

    db.items[itemId] = append(item, entry);
    this.save(db);
    return { ok: true, item: db.items[itemId], entry, scope_preview: preview };
  }

  // ---- the owner's verdict ----
  //
  // Stamps the proposal so the queue empties, appends a decision entry so the
  // thread still reads as a conversation, and - only when the proposal carried a
  // candidate output - publishes it and reports what the ledger decided.
  decide(actor, itemId, entryId, { verdict, note = null } = {}) {
    const guard = this.#assertOwner(actor);
    if (!guard.ok) return guard;
    if (!VERDICTS.includes(verdict)) return { ok: false, errors: ['verdict must be approved or rejected'] };

    const db = this.load();
    const item = db.items[itemId];
    if (!item) return { ok: false, errors: ['no such item'] };

    const target = thread(item).find((e) => e.id === entryId && e.kind === 'proposal');
    if (!target) return { ok: false, errors: ['no such proposal on this item'] };
    if (target.verdict) return { ok: false, errors: ['that proposal is already decided'] };

    const stamped = {
      ...item,
      thread: thread(item).map((e) => (e.id === entryId ? { ...e, verdict } : e)),
    };

    const entries = [makeEntry(itemId, 'decision', this.owner, note || '', { verdict, replyTo: entryId })];

    let published = null;
    if (verdict === 'approved' && target.candidate) {
      const res = this.ledger.publish(
        newOutput({
          ...target.candidate,
          // Forced, never accepted: the signer is this board's owner.
          producer: { fleet: this.fleet, agent: target.author, identity: this.owner },
        }),
      );
      if (!res.ok) return { ok: false, errors: res.errors };
      published = {
        id: res.output.id,
        scope: describe(res.output.scope),
        basis: res.output.scope_basis,
        status: res.output.status,
        at: new Date().toISOString(),
      };
      entries.push(
        makeEntry(
          itemId,
          'report',
          target.author,
          'published ' + res.output.id + ' at scope ' + published.scope,
          { published },
        ),
      );
    }

    let next = append(stamped, ...entries);
    if (published) next = { ...next, published };
    db.items[itemId] = next;
    this.save(db);

    return {
      ok: true,
      item: db.items[itemId],
      verdict,
      output: published ? this.ledger.get(published.id) : null,
      published,
    };
  }

  // The newest pending proposal on an item, which is what a one-click approve or
  // reject acts on.
  #newestPending(item) {
    const open = thread(item).filter((e) => e.kind === 'proposal' && !e.verdict);
    return open.length ? open[open.length - 1] : null;
  }

  approve(actor, itemId, note = null) {
    const item = this.load().items[itemId];
    if (!item) return { ok: false, errors: ['no such item'] };
    const target = this.#newestPending(item);
    if (!target) return { ok: false, errors: ['nothing proposed to approve'] };
    return this.decide(actor, itemId, target.id, { verdict: 'approved', note });
  }

  reject(actor, itemId, why) {
    const item = this.load().items[itemId];
    if (!item) return { ok: false, errors: ['no such item'] };
    const target = this.#newestPending(item);
    if (!target) return { ok: false, errors: ['nothing proposed to reject'] };
    return this.decide(actor, itemId, target.id, { verdict: 'rejected', note: why });
  }

  // ---- park and archive: both lossless ----
  //
  // Parking differs from archiving. A parked item stays on the board, in its own
  // column, because it is still real work that is deliberately not moving.
  // `parkedFrom` remembers the status it held, so unparking returns it to
  // `waiting` rather than to `now`.
  park(actor, itemId, reason) {
    const guard = this.#assertOwner(actor);
    if (!guard.ok) return guard;
    const db = this.load();
    const item = db.items[itemId];
    if (!item) return { ok: false, errors: ['no such item'] };
    if (item.status === 'parked') return { ok: false, errors: ['already parked'] };

    const parked = { ...item, status: 'parked', parkedFrom: item.status, parkedAt: new Date().toISOString(), parkReason: reason || null };
    db.items[itemId] = append(parked, makeEntry(itemId, 'change', 'system', 'Parked' + (reason ? ': ' + reason : '')));
    this.save(db);
    return { ok: true, item: db.items[itemId] };
  }

  unpark(actor, itemId) {
    const guard = this.#assertOwner(actor);
    if (!guard.ok) return guard;
    const db = this.load();
    const item = db.items[itemId];
    if (!item) return { ok: false, errors: ['no such item'] };
    if (item.status !== 'parked') return { ok: false, errors: ['not parked'] };

    const back = item.parkedFrom || 'now';
    const restored = { ...item, status: back, parkedFrom: undefined, parkedAt: undefined, parkReason: undefined };
    db.items[itemId] = append(restored, makeEntry(itemId, 'change', 'system', 'Unparked to ' + STATUSES[back].name));
    this.save(db);
    return { ok: true, item: db.items[itemId] };
  }

  // Archived items leave the board but keep every field, so restore is lossless.
  archive(actor, itemId, reason) {
    const guard = this.#assertOwner(actor);
    if (!guard.ok) return guard;
    const db = this.load();
    const item = db.items[itemId];
    if (!item) return { ok: false, errors: ['no such item'] };

    const archived = { ...item, archived: true, archivedAt: new Date().toISOString(), archiveReason: reason || null };
    db.items[itemId] = append(archived, makeEntry(itemId, 'change', 'system', 'Archived' + (reason ? ': ' + reason : '')));
    this.save(db);
    return { ok: true, item: db.items[itemId] };
  }

  restore(actor, itemId) {
    const guard = this.#assertOwner(actor);
    if (!guard.ok) return guard;
    const db = this.load();
    const item = db.items[itemId];
    if (!item) return { ok: false, errors: ['no such item'] };
    if (!item.archived) return { ok: false, errors: ['not archived'] };

    const back = { ...item, archived: false, archivedAt: undefined, archiveReason: undefined };
    db.items[itemId] = append(back, makeEntry(itemId, 'change', 'system', 'Restored to the board'));
    this.save(db);
    return { ok: true, item: db.items[itemId] };
  }

  // ---- the one thing that crosses to the platform board (D18) ----
  //
  // A request leaves, a status comes back. There is no route from here that
  // lists the platform queue. The item sits in `waiting`, with the ball
  // explicitly on the platform team, which is what `waitingOn` is for.
  async raise(actor, { type = 'grant_request', agent, target, justification }) {
    const guard = this.#assertOwner(actor);
    if (!guard.ok) return guard;
    if (!this.platformLink) return { ok: false, errors: ['no platform link configured'] };
    if (!['grant_request', 'access_request'].includes(type)) {
      return { ok: false, errors: ['type must be grant_request or access_request'] };
    }
    if (type === 'grant_request') {
      const laneGuard = this.#assertLane(agent);
      if (!laneGuard.ok) return laneGuard;
    }
    if (!justification) return { ok: false, errors: ['a request needs a one-line justification'] };

    const label = type === 'grant_request' ? 'invoke on ' + target : 'access to ' + target;
    const sub = await this.platformLink.submit({
      type,
      subject: type === 'grant_request' ? this.fleet + '/' + agent + ' -> ' + target : this.owner + ' -> ' + target,
      requester: this.owner,
      payload: {
        subject:
          type === 'grant_request'
            ? { type: 'fleet_agent', fleet: this.fleet, agent }
            : { type: 'employee', id: this.owner },
        agent: target,
        justification,
      },
    });
    if (!sub.ok) return sub;

    const created = this.add(actor, {
      title: 'Requested ' + label,
      lane: type === 'grant_request' ? agent : 'owner',
      kind: 'infra',
      status: 'waiting',
      waitingOn: 'platform team',
      next: 'wait for the platform team decision',
    });
    if (!created.ok) return created;

    const db = this.load();
    const item = db.items[created.item.id];
    item.platform_request = { id: sub.item.id, type, target, at: new Date().toISOString() };
    db.items[item.id] = append(item, makeEntry(item.id, 'instruction', this.owner, 'requested ' + label + ': ' + justification));
    this.save(db);
    return { ok: true, item: db.items[item.id], platform_item: sub.item.id };
  }

  // Kept for callers that predate raise().
  async requestGrant(actor, { agent, target, justification }) {
    return this.raise(actor, { type: 'grant_request', agent, target, justification });
  }

  // Pull, never push. The platform team cannot write into this board, so a
  // decision arrives when the fleet asks for the status of its own request.
  async syncDecisions() {
    const db = this.load();
    const updated = [];
    for (const item of Object.values(db.items)) {
      if (!item.platform_request || item.status !== 'waiting') continue;
      const st = await this.platformLink.status(this.owner, item.platform_request.id);
      if (!st.ok || st.state !== 'closed') continue;

      const decided = {
        ...item,
        status: st.decision === 'approved' ? 'now' : 'done',
        waitingOn: null,
        next: st.decision === 'approved' ? 'use the grant' : null,
        last_decision: { decision: st.decision, note: st.note || null, decided_at: st.decided_at },
      };
      db.items[item.id] = append(
        decided,
        makeEntry(item.id, 'note', this.owner, 'platform team decision: ' + st.decision + (st.note ? ' - ' + st.note : '')),
      );
      updated.push(item.id);
    }
    if (updated.length) this.save(db);
    return { ok: true, updated };
  }

  async grantStatus(itemId) {
    const item = this.get(itemId);
    if (!item || !item.platform_request) return { ok: false, reason: 'no request on this item' };
    return this.platformLink.status(this.owner, item.platform_request.id);
  }

  // ---- reading the board ----
  get(itemId) {
    return this.load().items[itemId] || null;
  }

  // The default board hides archived items and finished work, the same way a
  // real one does. Pass { all: true } to see everything.
  all(opts = {}) {
    const items = Object.values(this.load().items);
    const visible = opts.all ? items : items.filter((i) => !i.archived && !isClosed(i.status));
    return visible.sort((a, b) => (a.touched < b.touched ? 1 : a.touched > b.touched ? -1 : 0));
  }

  archived() {
    return Object.values(this.load().items).filter((i) => i.archived);
  }

  revision() {
    return this.load().revision || 0;
  }

  // Everything waiting on the owner: a proposal with no verdict, or a request
  // that has come back decided.
  waitingOnOwner() {
    const items = this.all({ all: true });
    const out = pending(items).map((p) => ({ item: p.item, entry: p.entry, why: 'proposal awaiting your verdict' }));
    for (const item of items) {
      if (item.last_decision && item.status === 'now') out.push({ item, entry: null, why: 'platform team decided' });
    }
    return out;
  }

  // Everything waiting on an agent: an instruction nobody has answered.
  waitingOnAgents(lane) {
    return awaitingAgent(this.all({ all: true }), lane);
  }

  proposals() {
    return allProposals(this.all({ all: true }));
  }

  columns() {
    return byStatus(this.all());
  }

  swimlanes() {
    return byLane(this.all());
  }

  laneRegistry() {
    return this.lanes.registry();
  }

  // The readable form of one item: its conversation without the bookkeeping.
  read(itemId) {
    const item = this.get(itemId);
    if (!item) return null;
    return {
      item,
      conversation: conversation(item),
      changes: thread(item).filter((e) => e.kind === 'change'),
      last: lastMovement(item),
      pending: this.#newestPending(item),
      instructionFor: (proposal) => instructionFor(item, proposal),
    };
  }

  statuses() {
    return STATUSES;
  }

  kinds() {
    return KINDS;
  }
}
