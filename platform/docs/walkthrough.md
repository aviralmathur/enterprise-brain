# A walkthrough of the two boards

Everything below is the seeded world — fictional (Alice, Bob, Carol, Dave), built only
through the real code paths. Start it yourself:

```bash
cd platform
node serve.mjs --seed     # prints tokens and two sign-in links
```

Then open the links it prints. No build step; the token rides in the URL fragment and never
reaches the server.

## Two boards, because there are two owners

The split is a privacy boundary, not a theme. One employee runs the dark board; the platform
team runs the light one. Neither can read the other's.

### Fleet Mission Control — one employee's private cockpit

![Fleet Mission Control — the Jira-style board](img/northwind-board.png)

One employee's own board. **Group by Status, Owner or Kind** with the toggle, and filter to any
set of agents with the colour chips. Each section carries a count and, per agent, a state badge —
*Working*, *Waiting*, *Blocked*, *Idle* — derived from its own tasks. Click an agent's section
header and its state opens as a **pop-up**: role, who it reports to, and its open tasks, each a
link back to the item.

The board above is the Northwind Ops fleet (`node northwind.mjs`), grouped by owner: the
`Reconcile on-time` task sits with **Tally**, the `Ardent Freight` note waits on **Relay**, and
the whole fleet is one glance.

### Org chart — owner, orchestrator, employees

![Org chart](img/northwind-orgchart.png)

The **Org chart** tab is a real reporting tree: the fleet owner (a human) at the top, the
**orchestrator** (the chief-of-staff agent) beneath, and every other AI employee reporting
through it. Every node is clickable — same state pop-up as the board.

### Platform Mission Control — the governance desk

![Platform Mission Control](img/platform-mission-control.png)

The platform team's review surface. Outputs by state and status, the grant review queue, and

### Platform Mission Control — the governance desk

![Platform Mission Control](img/platform-mission-control.png)

The platform team's review surface. Outputs by state and status, the grant review queue, and
the part a fleet board never has: **Audit, by action** — every consume, invoke, grant and auth
decision with its refused count — and **Live conflicts**, where two disagreeing figures
(`rev_q3`, `billing_q3`) are surfaced and deliberately *not* resolved. The brain never picks a
winner; a person does.

## The one thing a wiki cannot do

The whole design exists to make one property true: **correct an output, and everything derived
from it goes stale by itself** — and a derived output's audience is **computed** from its inputs,
never declared by its producer. Watch both, on real ledger state:

```bash
node demo-cascade.mjs
```

```
1 · The audience was COMPUTED, not declared
  id           audience                 freshness
  rev_q3       3 named: alice, bob, dave fresh
  billing_q3   2 named: alice, bob      fresh
  recon_q3     2 named: alice, bob      fresh
  → recon_q3 is visible to { alice, bob } — the INTERSECTION of its inputs,
    not the wider warehouse list. Restricted data cannot be laundered wider.

2 · Correct one upstream figure — watch the cascade
  id           audience                 freshness
  rev_q3       3 named: alice, bob, dave stale
  recon_q3     2 named: alice, bob      stale
  → correcting rev_q3 invalidated everything derived from it: [recon_q3]
    Nobody marked recon_q3 stale by hand. The derived_from edge did it.
```

`recon_q3` was a reconciliation note Alice's analyst built from two enterprise figures that
disagree. Its audience is the **intersection** of its inputs — the narrower two-person billing
list, not the wider warehouse one. When the warehouse re-cuts Q3 and `revenue-desk` supersedes
`rev_q3`, `recon_q3` goes stale on its own. Nobody touched it; the `derived_from` edge did.

That supersede is also **owner-only**: only `revenue-desk` may replace its own output. An
employee fleet naming `rev_q3` as something to supersede is refused — one injected fleet cannot
stale an enterprise-wide fact. See the `Adversarial — cross-tenant integrity` phase in
`acceptance/run.mjs` for that and four sibling checks, each red before its fix.

## Everything a board does, a `curl` can do

There is no privileged path. The page is a thin client over the same API, with the same token:

```bash
curl -s "http://127.0.0.1:8080/ledger/ask?agent=analyst&subject=q3_revenue" \
  -H "authorization: Bearer <alice-token>"
```

The answer comes back filtered to what Alice may see, cites its provenance, and flags the
conflict — which is what makes the API, not the page, the thing under test.
