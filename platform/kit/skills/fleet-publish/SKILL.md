---
name: fleet-publish
description: >
  Put something a fleet agent produced onto the Enterprise Brain's shared ledger,
  through the approve gate on the employee's own Mission Control board. Use when
  the user wants to publish, share or promote an output, or when an agent has
  finished work that other people should be able to consume. Trigger on "publish
  this", "share this with the team", "put this on the ledger", "promote this
  output", "make this available", "why is my output fleet-private". The approve
  step is the publish action — nothing reaches the ledger any other way.
---

# fleet-publish — propose, then approve

Writing up to the shared ledger always passes a gate. That gate is the **approve**
step on the employee's own board, and the employee is the accountable signer.

## The thread

```js
const item = fleet.board.instruct('<employee>', '<what was asked for>', { lane: '<agent>' }).item;

const proposed = fleet.board.propose(item.id, {
  agent: '<agent>',
  proposal: {
    understanding: '<one line restating the ask>',
    actions: ['<how the output was produced>'],
    needs: [],
    caution: '<what you deliberately did not do>',
    source: 'agent',
  },
  candidate: {
    id: '<outputId>',
    kind: '<kind>',
    body: { subject: '<subject>', value: <value> },
    sources: [{ system: 'gmail', ref: '<ref>', harness: true }],
    derived_from: ['<upstreamId>'],
  },
});

// The audience the ledger WILL compute, before anyone signs. Writes nothing.
proposed.scope_preview.scope_label;
proposed.scope_preview.overruled;   // true when the producer asked for something wider

fleet.board.approve('<employee>', item.id);   // ← this verdict publishes
```

Nothing is on the ledger until the verdict. A proposal the employee rejects never
leaves the fleet.

Show the user `scope_preview` before asking for the verdict. It is the one moment
they can see who will be able to read this, and `overruled` tells them plainly
that the agent asked for a wider audience than it is going to get.

A verdict on a proposal with no candidate authorises a plan and publishes
nothing. Only a candidate output makes the verdict a publish. See `fleet-board`.

## Do not set the scope

You may pass a `scope` on the candidate and it will be **ignored**. The ledger
computes it:

- built from other outputs → the **intersection** of their scopes
- any source marked `harness: true` → **fleet-private**, always
- a fleet agent's root output with neither → fleet-private

This is deliberate. If a deriving agent could declare its own scope, restricted
data would leak into a wider audience through a legitimate, audited path that
nobody notices until it matters.

So when the user asks *"why is this only visible to me?"*, the answer is in
`output.scope_basis` — read it back to them rather than speculating.

## Getting something widened

You cannot. A widening request routes to the owner of the **narrowest input**:

```js
platform.ledger.attemptWiden('<outputId>', { type: 'org' });
// -> { ok: false, route_to: <the narrowest input's scope> }
```

Tell the user who has to agree. Do not offer to republish the same content as a
fresh root output to escape the intersection — that is laundering, and it is the
one thing this design exists to stop.

## Declare your sources honestly

`sources` and `derived_from` are what the whole cascade runs on. Two failure modes,
both serious:

- **Omitting `derived_from`** makes an output look like an original, so a
  correction upstream will never invalidate it. Someone quotes a stale figure.
- **Omitting `harness: true`** on a source that came from the employee's own mail
  or tickets lets the ledger compute a wider scope than it should.

If you are unsure whether something counts as an input, include it. An
over-declared input narrows the scope, which is the safe direction.

## Rules

- One `approve` per proposal. If the content changes, propose again.
- Never approve on someone else's behalf. The board refuses it, and attempting it
  means you have the wrong actor.
