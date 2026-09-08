---
name: fleet-board
description: >
  Run the employee's own Mission Control board — the private cockpit where fleet
  work is instructed, proposed, approved and reported back. Use when the user asks
  what their fleet is working on, wants to see or drive open items, asks what is
  waiting on them, or wants the history of how something was produced. Trigger on
  "my board", "mission control", "what's my fleet doing", "what's waiting on me",
  "show me the thread", "what did my agent do". Private to the owner — the platform
  team cannot see it.
---

# fleet-board — the private cockpit

One operator: the owner. The board is the record of what the fleet was asked to do
and what it did, and it holds the approve step that publishes an output.

## The thread shape is fixed

```
instruct  →  propose  →  approve  →  report
 (owner)     (agent)     (owner)     (agent)
```

Fixed by the platform, not by the fleet. Do not invent extra states, skip
`propose` to publish directly, or record an approval that the owner did not give.

```js
fleet.board.instruct('<employee>', '<what is wanted>');
fleet.board.propose(itemId, { agent, candidate, note });
fleet.board.approve('<employee>', itemId);   // publishes
fleet.board.reject('<employee>', itemId, '<why>');
fleet.board.report(itemId, { agent, text: '<what happened>' });
```

## Reading the board

```js
fleet.board.all();        // every item
fleet.board.get(itemId);  // one item with its full thread
```

Item states: `instructed`, `proposed`, `published`, `rejected`,
`awaiting_grant`.

When the user asks what needs them, the answer is everything in `proposed` — those
are waiting on an approve or reject — plus anything in `awaiting_grant` that has
come back decided.

## Report back honestly

`report` is where an agent says what it actually did. Two rules:

- Record what happened, including failures. An item whose agent hit a refusal and
  reported nothing is worse than one that reported the refusal — the owner then
  believes work is in progress that has stopped.
- Never write a `report` describing work that was not done, and never post one on
  behalf of an agent that did not run.

## It is private, and that matters

The platform team cannot read this board. Drafts, rejected proposals, half-formed
instructions and anything the owner decided against stay here.

That is what makes it safe to think out loud on. So do not:

- copy the board's contents into an output body to "share context"
- summarise rejected proposals into anything that gets published
- treat a rejection as an obstacle to route around

A rejected proposal is a decision. Let it stay rejected.

What governance *does* see is every consume and invoke that crossed the fleet
boundary, and every output that made it through the gate. If the user asks what
the platform team can see, that is the honest answer: actions against enterprise
systems, and published outputs — not this board.

## Handing off

- publishing a proposal → `fleet-publish`
- an item blocked on access → `fleet-access`
- an item needing a live call → `fleet-invoke`
- reading what already exists → `fleet-consume`

## Rules

- The owner is the only actor who may `instruct`, `approve` or `reject`. If a call
  is refused with "this board belongs to X", you are running as the wrong actor —
  stop rather than retrying as someone else.
- One board per fleet, in the owner's own workspace. Never read another employee's
  board file, even if the path is guessable.
