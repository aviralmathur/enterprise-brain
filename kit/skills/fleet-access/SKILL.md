---
name: fleet-access
description: >
  Ask the platform team for access or an invoke grant, and check where a request
  stands. Use when a read or invoke was refused for lack of access, when the user
  wants one of their agents to be able to act on an enterprise system, or when they
  ask about a pending request. Trigger on "request access", "ask for a grant", "my
  agent needs to be able to", "why was I refused", "where is my access request",
  "chase the platform team", "who approves this". Raises requests; it never grants
  anything itself.
---

# fleet-access — request access, check status

Two different things get asked for, and confusing them wastes a round trip with
the platform team.

| Refusal you saw | What to request |
|---|---|
| `not on the access list for X` | **Access** — be added to that agent's list. Until then you cannot even consume its outputs. |
| `no live grant for <fleet>/<agent> on X` | **A grant** — invoke permission for one named agent. Consume already works. |

Invoke is never on by default. That is a decision, not an oversight, so do not
present it to the user as a misconfiguration.

## Raise the request

```js
await fleet.board.requestGrant('<employee>', {
  agent: '<the agent in my fleet that needs it>',
  target: '<the enterprise agent>',
  justification: '<why, in one line>',
});
```

The request leaves the employee's board and becomes an item in the platform team's
Mission Control — either a URL away or linked directly, depending on how the fleet
was configured. This is the **only** thing that crosses between the two boards.

Write the justification for a reviewer who does not know the work: what the agent
will do with it, and how often. "Weekly ops note" beats "needs access".

## Check status

```js
await fleet.board.grantStatus('<fleetItemId>');
// -> { ok, state, decision, decided_at, note }
```

You can see the status of **your own** request and nothing else. There is no route
that lists the platform queue, so do not offer to look up someone else's request
or report on the team's backlog — you cannot see it, and saying otherwise invents
information.

## What a grant is

Every grant is **time-boxed** and revocable, and it is issued to either an employee
or one named agent in one named fleet. Consequences worth telling the user plainly:

- it will expire, and the invoke will start failing when it does
- revocation takes effect immediately, with no cleanup step
- a grant on `analyst` does nothing for `writer` — grants do not spread across a
  fleet

## When a request is rejected

Report the decision and the note. Do not re-raise the same request, and do not
look for another agent that reaches the same system. If the user disagrees with
the decision, the next step is a conversation with the DRI named on the agent, not
another request.

## Rules

- Never issue, extend or modify a grant from inside a fleet. Only the platform
  team does that; a fleet can only ask.
- One request per agent-and-target pair. Duplicates make the queue worse and the
  answer no faster.
