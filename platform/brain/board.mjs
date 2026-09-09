// Mission Control: the vocabulary both boards speak.
//
// One board or two is an architecture question (D9 says two, because a private
// cockpit and a review queue are different products). What a *turn* looks like is
// not: an item, a status, a lane that owns it, and an append-only thread of
// entries. That grammar lives here so nobody has to learn it twice, and so the
// brain stays the only place it is defined.
//
// Two things this model insists on, and both are load-bearing:
//
//   1. A thread is append-only. Nothing is edited and nothing is removed, so the
//      thread IS the item's history rather than a view of it. A field change is
//      itself an entry, which is why you can read an item and know how it got
//      here.
//   2. A proposal is structured, not prose. An agent has to say what it
//      understood, what it will do, what it needs, and what it will deliberately
//      not do. A one-line "sounds good" cannot be approved, because there is
//      nothing there to approve.
//
// Nothing in this file reads the environment or touches storage. Pure functions
// and vocabulary only, so the boards, the host and a client can all import it.

// ---- work status: where the work is, not where the conversation is ----
//
// Keeping these separate from the thread is the change that makes a board
// readable. "Proposed" is a fact about a conversation; "Blocked" is a fact about
// the work. An item can be blocked with nothing pending, or in flight with three
// answered instructions behind it.
export const STATUSES = {
  now: { name: 'In flight', blurb: 'moving, ball is with us' },
  blocked: { name: 'Blocked', blurb: 'something must break first' },
  waiting: { name: 'Waiting on', blurb: 'ball is with someone else' },
  parked: { name: 'Parked', blurb: 'deliberately not now' },
  done: { name: 'Done', blurb: 'finished, nothing owed' },
  shipped: { name: 'Shipped', blurb: 'live, needs nothing' },
};

export const STATUS_ORDER = ['now', 'blocked', 'waiting', 'parked', 'done', 'shipped'];

// Work that is over. Neither counts toward an agent's open load, and neither
// shows on the default board.
export const isClosed = (s) => s === 'done' || s === 'shipped';

// ---- what kind of thing an item is ----
export const KINDS = ['product', 'pursuit', 'demo', 'thread', 'task', 'infra', 'decision'];

// ---- one turn in a thread ----
export const ENTRY_KINDS = [
  'instruction', // the owner tells the owning agent what to do
  'proposal', //    the agent's reply: what it intends to do
  'decision', //    the owner's verdict on a proposal
  'note', //        the owner logging something by hand
  'report', //      the agent reporting back after a real session
  'change', //      a field changed: logged automatically, never written by hand
];

export const VERDICTS = ['approved', 'rejected'];
export const VERDICT_LABEL = { approved: 'Approved', rejected: 'Rejected' };

// Where a proposal's text actually came from. Kept vendor-neutral on purpose
// (D12): the brain never names a harness.
//
//   agent    the real agent answered from its own session, with its charter,
//            memory and tools. The reply worth approving.
//   summary  the board's own model call. A charter-shaped guess at what the
//            agent would say, useful to unblock a queue, weaker than the agent.
//   offline  a placeholder written when nothing could answer. Never approved
//            without a human rewriting it first.
export const PROPOSAL_SOURCES = ['agent', 'summary', 'offline'];

// ---- lanes ----
//
// A lane is who owns the item. The repo ships a generic set because a real
// deployment's lanes are its own org chart, and hardcoding somebody's agent
// names into a shared library is how a library stops being shared. Pass your own
// to `lanes()`; `owner` is always present because the person running the board
// owns items too.
export const DEFAULT_LANES = {
  owner: { name: 'Owner', role: 'the person running this board' },
  analyst: { name: 'Analyst', role: 'reads and reconciles' },
  briefer: { name: 'Briefer', role: 'inbox, briefs and triage' },
  builder: { name: 'Builder', role: 'one-off models and checks' },
};

export function lanes(custom) {
  const merged = { owner: DEFAULT_LANES.owner, ...(custom || DEFAULT_LANES) };
  return {
    all: () => Object.keys(merged),
    get: (id) => merged[id] || null,
    has: (id) => Boolean(merged[id]),
    name: (id) => (merged[id] ? merged[id].name : id),
    role: (id) => (merged[id] ? merged[id].role : null),
    registry: () => ({ ...merged }),
  };
}

const today = () => new Date().toISOString().slice(0, 10);

// ---- items ----
export function newItem(fields) {
  return {
    id: fields.id,
    title: fields.title,
    lane: fields.lane || 'owner', // who owns it
    kind: KINDS.includes(fields.kind) ? fields.kind : 'task',
    status: STATUSES[fields.status] ? fields.status : 'now',
    tag: fields.tag || null, // client, product or programme
    next: fields.next || null, // the single next action. Keep it a verb.
    waitingOn: fields.waitingOn || null, // who the ball is with, when it is not us
    due: fields.due || null, // YYYY-MM-DD
    touched: fields.touched || today(),
    confidential: Boolean(fields.confidential),
    note: fields.note || null,
    links: fields.links || [],
    thread: [],
    created_at: new Date().toISOString(),
  };
}

export function validateItem(item, laneReg) {
  const e = [];
  if (!item || !item.title) e.push('an item needs a title');
  if (!STATUSES[item && item.status]) e.push('status must be one of ' + STATUS_ORDER.join('|'));
  if (item && item.kind && !KINDS.includes(item.kind)) e.push('kind must be one of ' + KINDS.join('|'));
  if (laneReg && item && item.lane && !laneReg.has(item.lane)) e.push('unknown lane: ' + item.lane);
  if (item && item.due && !/^\d{4}-\d{2}-\d{2}$/.test(item.due)) e.push('due must be YYYY-MM-DD');
  return e;
}

// ---- entries ----
export function entryId(itemId, kind) {
  const rand = Math.random().toString(36).slice(2, 7);
  return itemId + '-' + kind[0] + Date.now().toString(36) + rand;
}

export function makeEntry(itemId, kind, author, body, extra = {}) {
  return {
    id: entryId(itemId, kind),
    at: new Date().toISOString(),
    author, // the owner's id, a lane, or 'system' for automatic entries
    kind,
    body,
    ...extra,
  };
}

export const thread = (item) => (item && item.thread) || [];

// Append-only, and always left in chronological order. `touched` is only
// refreshed on items that carry it, so this stays usable by a board whose items
// have a different field set.
export function append(item, ...entries) {
  const next = [...thread(item), ...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const moved = { ...item, thread: next };
  if ('touched' in item) moved.touched = today();
  return moved;
}

// A proposal has to be answerable. This is the check that stops "looks fine"
// from reaching a verdict.
export function validateProposal(p) {
  const e = [];
  if (!p) return ['a proposal is required'];
  if (!p.understanding) e.push('understanding is required: restate the ask in one line');
  if (!Array.isArray(p.actions) || !p.actions.length) e.push('actions must list at least one concrete step');
  if (!Array.isArray(p.needs)) e.push('needs must be an array, empty if nothing is needed');
  if (!PROPOSAL_SOURCES.includes(p.source)) e.push('source must be one of ' + PROPOSAL_SOURCES.join('|'));
  return e;
}

// ---- reading a thread ----
export const conversation = (item) => thread(item).filter((e) => e.kind !== 'change');

export const lastMovement = (item) => {
  const t = thread(item);
  return t.length ? t[t.length - 1] : null;
};

// True when nothing has answered this instruction yet.
export function unanswered(item, instruction) {
  if (instruction.kind !== 'instruction') return false;
  return !thread(item).some((e) => e.kind === 'proposal' && e.replyTo === instruction.id);
}

// Instructions the owning agent has not replied to, oldest first. This is what
// an agent picks up in its next session.
export function awaitingAgent(items, lane) {
  const out = [];
  for (const item of items) {
    if (lane && item.lane !== lane) continue;
    for (const entry of thread(item)) {
      if (entry.kind === 'instruction' && unanswered(item, entry)) out.push({ item, entry });
    }
  }
  return out.sort((a, b) => (a.entry.at < b.entry.at ? -1 : 1));
}

// Proposals still waiting on a verdict, newest first. This is what is waiting on
// the person running the board.
export function pending(items) {
  const out = [];
  for (const item of items) {
    for (const entry of thread(item)) {
      if (entry.kind === 'proposal' && !entry.verdict) out.push({ item, entry });
    }
  }
  return out.sort((a, b) => (a.entry.at < b.entry.at ? 1 : -1));
}

export function allProposals(items) {
  const out = [];
  for (const item of items) {
    for (const entry of thread(item)) if (entry.kind === 'proposal') out.push({ item, entry });
  }
  return out.sort((a, b) => (a.entry.at < b.entry.at ? 1 : -1));
}

// The instruction a proposal answered, so a verdict can be read in context.
export function instructionFor(item, proposal) {
  if (!proposal.replyTo) return null;
  return thread(item).find((e) => e.id === proposal.replyTo) || null;
}

// ---- field changes are entries too ----
export const PATCH_FIELDS = {
  status: 'Status',
  next: 'Next action',
  waitingOn: 'Waiting on',
  due: 'Due',
};

// A one-line, human description of what actually changed. Null when the patch is
// a no-op, so a pointless entry never lands in a thread.
export function describeChange(before, patch) {
  const parts = [];
  for (const key of Object.keys(PATCH_FIELDS)) {
    if (!(key in patch)) continue;
    const from = before[key] || '';
    const to = patch[key] || '';
    if (String(from) === String(to)) continue;

    const label = PATCH_FIELDS[key];
    if (key === 'status') {
      parts.push(label + ': ' + STATUSES[before.status].name + ' -> ' + STATUSES[patch.status].name);
    } else if (!to) {
      parts.push(label + ' cleared');
    } else if (!from) {
      parts.push(label + ' set to "' + to + '"');
    } else {
      parts.push(label + ': "' + from + '" -> "' + to + '"');
    }
  }
  return parts.length ? parts.join(' - ') : null;
}

// ---- grouping, for a board view ----
export function byStatus(items) {
  const out = {};
  for (const s of STATUS_ORDER) out[s] = [];
  for (const item of items) (out[item.status] || (out[item.status] = [])).push(item);
  return out;
}

export function byLane(items) {
  const out = {};
  for (const item of items) (out[item.lane] || (out[item.lane] = [])).push(item);
  return out;
}
