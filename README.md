# Enterprise Brain — reference implementation

The sanctioned way for employees to build agent fleets, and the shared ledger
through which those fleets consume what the enterprise's own agents produce.

This is a **working reference implementation**, not a production deployment. Every
rule in [`spec/contracts.md`](spec/contracts.md) is enforced by real code and
proved by a runnable check. Two things are seams rather than integrations, and are
marked as such below.

```bash
node demo.mjs          # narrated end-to-end walkthrough, 13 steps
node acceptance/run.mjs # the roadmap's exit tests as runnable checks
```

No dependencies. Node 18+. All state is plain text under `data/` — `cat
data/demo/ledger.jsonl` is a feature, not a debugging affordance.

## Why this is a brain and not a wiki

Correcting one output invalidates everything derived from it. That single
property — the `derived_from` edge plus the cascade — is what the whole design
exists to make true, and it is what nothing else in this space offers.

```
before: ops_note is fresh
after:  ops_note is stale — upstream rev_q4 was superseded by rev_q4_v2
```

The second property is that a derived output's scope is **computed**, not
declared:

```
agent asked for: org-wide
ledger computed: 1 named: sarah
basis: intersection of 2 input(s); narrowest was 1 named: sarah
→ restricted data cannot be laundered into a wider audience
```

## Layout

Three trees. The dependency direction is the point: both fleets depend on the
brain; the brain depends on neither, and contains nothing harness-specific.

```
brain/                  the ledger and everything harness-agnostic (D12)
  schema.mjs            the output object; a vendor adapter target
  scope.mjs             the scope lattice and intersection
  ledger.mjs            append-only store, computed scope, cascade, tombstones
  provenance.mjs        derived_from graph, descendants, conflicts
  query.mjs             the consume path: two checks, cites provenance
  identity.mjs          ── SEAM: the IdP. Local provider; stores nothing.
  audit.mjs             everything crossing the fleet boundary
  telemetry.mjs         usage → deprecation candidates
  gates.mjs             status from a check that can fail

platform-fleet/         owned and governed by the platform team (D1)
  registry.mjs          agent manifests, scope review, lifecycle
  grants.mjs            time-boxed invoke grants
  gateway.mjs           the only enforcement that counts (D13)
  board.mjs             thin review queue (D19)
  connectors/           ── SEAM: ServiceNow / Agentforce / Copilot adapters

employee-fleet/         self-serve, free to create (D2)
  fleet.mjs             registration; stable agent ids
  enforce.mjs           advisory local check — worthless against intent
  board.mjs             private cockpit; approve == publish

spec/contracts.md       the Phase 0 contracts
acceptance/run.mjs      27 checks, one per exit test or decision
wire.mjs                assembly; the only file that knows every part
```

## The two seams

Everything else is real. These two are interfaces with a local implementation
behind them, because neither can exist on a laptop:

| Seam | What is real | What to swap in |
|---|---|---|
| **Identity** (`brain/identity.mjs`) | The provider contract, and the invariant that the brain re-resolves on every call and **persists no entitlements** — proved by a check that walks every stored record | A real IdP client. `resolve(employeeId) → { id, status, entitlements }` is the whole surface. |
| **Connectors** (`platform-fleet/connectors/`) | The normalise-to-schema contract, the `auth_mode` declaration that drives scope review, and read-vs-write op classification that forces approval | A real vendor client in `call()`. `normalise()` does not change. |

Swapping either is a config change. Nothing above those files moves.

## The two boards are different products

Not one component instanced twice (D9).

| | Fleet Mission Control | Platform Mission Control |
|---|---|---|
| Operator | one employee | a team, with assignment |
| Item subject | my own work | someone else's request |
| Thread | instruct → propose → approve → report | request → review → decide → notify |
| An item does | publishes an output to the ledger | changes a grant, scope or lifecycle |
| Audit | private, unaudited | every decision is an audit record |

They share exactly one interface: a grant request leaves the fleet board, becomes
an item in the platform queue, and the decision returns as a status on the
requester's own item (D18). Neither side can read the other's board.

The platform board ships **thin** (D19) — items, assignee, decision, audit record.
SLAs, standing recurring reviews and conflict adjudication are Phase 6, specified
from what the team was actually doing by hand. An acceptance check asserts those
fields are still absent, so the deferral stays honest.

## What the acceptance suite proves

27 checks, grouped by the phase whose exit test they are.

| Phase | Proves |
|---|---|
| 1 | cascade invalidation; scope cannot be widened by its producer; harness sources floor at fleet-private; tombstone-plus-cascade; departed signers frozen |
| 2 | two employees, same question, correctly different answers; provenance and status on every answer; **no entitlement stored anywhere in the brain**; a former employee is refused |
| 3 | onboarding takes a manifest and a review and no platform code; scope review blocks org-wide over a service account; the same agent publishes as platform-internal; retiring marks outputs stale; the board is still thin |
| 4 | a fleet consumes on first run with zero manual grants; an ungranted invoke is refused by the gateway; **disabling the local check changes nothing**; approve is the publish gate; nobody drives someone else's board |
| 5 | granted invokes, identical ungranted refused, both audited; every vendor write terminates at a human; the gateway sheds rather than passing a stampede; revocation is immediate; the boards share only the grant request |
| 6 | status comes from a check that can fail; telemetry surfaces unused agents; conflicting answers are surfaced, never resolved |

A phase that cannot pass its check has not shipped, whatever the code says.

## Known gaps

Honest list, in the order they would bite.

1. **Single-process, file-backed.** The ledger is JSONL folded in memory. Correct
   and inspectable; not concurrent. A real deployment needs a database with the
   same append-only semantics — the `Ledger` interface is what to preserve.
2. **No real IAM or vendor tenancy.** See the seams above.
3. **Fleet-board privacy is enforced by an owner check**, not by separate
   storage per tenant. Correct behaviour, wrong isolation for production.
4. **Subscriptions (component 16) are not built.** Phase 6, and the only
   component in the plan with no code here.
5. **Load shedding is a per-minute rate limit and an in-flight cap.** Real
   shedding needs a queue with priorities.
6. **`conflicts()` compares `body.value` by identity.** Real conflict detection
   needs per-kind comparators.
