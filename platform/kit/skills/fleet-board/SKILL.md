---
name: fleet-board
description: >
  Run the employee's own Mission Control board — the private cockpit where fleet
  work is instructed, proposed, decided and reported back. Use when the user asks
  what their fleet is working on, what is waiting on them, what is waiting on an
  agent, wants to see or drive open items, wants to park or archive something, or
  wants the history of how a thing came to be. Trigger on "my board", "mission
  control", "what's my fleet doing", "what's waiting on me", "show me the thread",
  "what did my agent do", "park this", "archive this". Private to the owner — the
  platform team cannot see it.
---

# fleet-board — the private cockpit

One operator: the owner. The board holds what the fleet was asked to do, what it
proposed, what was decided, and what actually happened.

There are two things on it, and keeping them apart is what makes it readable:

- **an item** is a piece of work. It has a lane, a kind and a **status**.
- **a thread** is what has happened on that item, oldest first, append-only.

A status is a fact about the work. A thread position is a fact about the
conversation. An item can be blocked with nothing pending, or in flight with
three answered instructions behind it, and the board has to be able to say so.

## The item

| Field | What it is |
|---|---|
| `lane` | which agent owns it. Lanes are the fleet's registered agents, plus `owner` for the person themself. |
| `kind` | `product`, `pursuit`, `demo`, `thread`, `task`, `infra`, `decision` |
| `status` | where the **work** is (below) |
| `next` | the single next action. Keep it a verb. |
| `waitingOn` | who the ball is with, when it is not us |
| `tag` | client, product or programme |
| `due` | `YYYY-MM-DD` |
| `touched` | last movement. Set by the board, never by hand. |

Six statuses, and nothing else:

| Status | Shown as | Means |
|---|---|---|
| `now` | In flight | moving, ball is with us |
| `blocked` | Blocked | something must break first |
| `waiting` | Waiting on | ball is with someone else |
| `parked` | Parked | deliberately not now |
| `done` | Done | finished, nothing owed |
| `shipped` | Shipped | live, needs nothing |

`done` and `shipped` both close an item. Neither counts toward an agent's open
load and neither shows on the default board.

## The thread

```
instruction  ->  proposal  ->  decision  ->  report
  (owner)        (agent)       (owner)      (agent)
```

Six entry kinds. The first three are the loop; the rest are how reality gets
recorded.

| Kind | Author | What it is |
|---|---|---|
| `instruction` | owner | what is wanted |
| `proposal` | the lane | what the agent intends to do |
| `decision` | owner | the verdict on a proposal |
| `note` | owner | something that happened, logged by hand |
| `report` | the lane | what the agent actually did, after a real session |
| `change` | the board | a field changed. Written automatically. |

Append-only. Nothing here is ever edited or removed, so the thread **is** the
item's history rather than a view of it.

```js
fleet.board.add('<employee>', { title, lane, kind, status, next, tag });
fleet.board.instruct('<employee>', '<what is wanted>', { lane, kind });  // creates the item and posts the first instruction
fleet.board.post('<employee>', itemId, 'instruction' | 'note' | 'report', '<text>');
fleet.board.patch('<employee>', itemId, { status, next, waitingOn, due });
fleet.board.read(itemId);   // { item, conversation, changes, last, pending }
```

## A proposal is structured, not prose

An agent does not reply with a sentence. It replies with something that can be
approved:

```js
fleet.board.propose(itemId, {
  agent: '<lane>',
  proposal: {
    understanding: '<one line restating the ask in your own words>',
    actions: ['<the concrete steps you will take>'],
    needs: ['<what you need from the owner, or what blocks you>'],
    caution: '<what you will deliberately NOT do, per your charter>',
    source: 'agent',
  },
  candidate: { /* optional: an output to publish. See fleet-publish. */ },
});
```

`source` says where the reply came from, and it changes how much a verdict is
worth:

- `agent` — the real agent answered from its own session, with its charter,
  memory and tools. The reply worth approving.
- `summary` — the board's own model call. A charter-shaped guess at what the
  agent would say. Useful to unblock a queue, weaker than the agent.
- `offline` — nothing could answer. Never approve one without rewriting it.

A proposal with no `actions` is refused. If there is nothing concrete in it,
there is nothing to approve.

## A verdict authorises. It does not execute.

```js
fleet.board.decide('<employee>', itemId, entryId, { verdict: 'approved', note: '<why>' });
fleet.board.approve('<employee>', itemId);          // the newest pending proposal
fleet.board.reject('<employee>', itemId, '<why>');
```

Approving a **plan** records approved intent. Nothing runs. The agent carries it
out in its next session and posts a `report` on the same thread. Never write a
report for work that has not happened, and never tell the user something is done
because it was approved.

Approving a proposal that carries a **candidate output** is the exception: that
verdict *is* the publish action, and the board appends the report itself naming
the output and the scope the ledger computed. See `fleet-publish`.

A decided proposal is closed. If the plan changes, propose again.

## Two queues, and neither is the other

```js
fleet.board.waitingOnOwner();        // proposals with no verdict, and decisions that came back
fleet.board.waitingOnAgents(lane);   // instructions nobody has answered yet
```

When the user asks what needs them, the answer is the first list. When they ask
what their fleet owes them, it is the second. Answering one with the other is the
most common way to make a board useless.

## Park and archive are different, and both are lossless

```js
fleet.board.park('<employee>', itemId, '<why>');     // stays on the board, in Parked
fleet.board.unpark('<employee>', itemId);            // returns to the status it left
fleet.board.archive('<employee>', itemId, '<why>');  // leaves the board, keeps every field
fleet.board.restore('<employee>', itemId);
```

A parked item is still real work that is deliberately not moving, so it stays
visible. Unparking returns it to the status it held — a parked `waiting` item
comes back as `waiting`, not as `now`. Archiving takes it off the board and keeps
everything, so restoring is lossless too. Nothing is ever deleted.

## Reading the board back to the user

```js
fleet.board.all();              // open work, newest movement first
fleet.board.all({ all: true }); // including closed and archived
fleet.board.columns();          // grouped by status
fleet.board.swimlanes();        // grouped by lane
fleet.board.revision();         // bumped on every write
```

Lead with what is waiting on them. Then what is blocked, and what it is blocked
on. Do not read the whole board out; name the count and the two or three items
that need a decision.

## Report back honestly

- Record what happened, including failures. An item whose agent hit a refusal and
  reported nothing is worse than one that reported the refusal: the owner then
  believes work is in progress that has stopped.
- Never post a `report` describing work that was not done, and never post one on
  behalf of an agent that did not run.
- A `change` entry cannot be written by hand. The board writes it, so the history
  of a field is trustworthy. Attempting one is refused.

## It is private, and that matters

The platform team cannot read this board. Drafts, rejected proposals, half-formed
instructions and anything the owner decided against stay here. That is what makes
it safe to think out loud on. So do not:

- copy the board's contents into an output body to "share context"
- summarise rejected proposals into anything that gets published
- treat a rejection as an obstacle to route around

A rejected proposal is a decision. Let it stay rejected.

What governance *does* see is every consume and invoke that crossed the fleet
boundary, and every output that made it through the gate. If the user asks what
the platform team can see, that is the honest answer: actions against enterprise
systems, and published outputs. Not this board.

## Handing off

- publishing a proposal → `fleet-publish`
- an item blocked on access → `fleet-access`
- an item needing a live call → `fleet-invoke`
- reading what already exists → `fleet-consume`

## Rules

- The owner is the only actor who may `add`, `instruct`, `patch`, `decide`,
  `park` or `archive`. If a call is refused with "this board belongs to X", you
  are running as the wrong actor: stop rather than retrying as someone else.
- A lane has to be an agent the fleet actually registered. An unknown lane is
  refused, because a lane nobody can address is a queue nobody empties.
- One board per fleet, in the owner's own workspace. Never read another
  employee's board file, even if the path is guessable.
