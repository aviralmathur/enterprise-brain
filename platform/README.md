# Enterprise Brain — reference implementation

The sanctioned way for employees to build agent fleets, and the shared ledger
through which those fleets consume what the enterprise's own agents produce.

This is a **working reference implementation**, not a production deployment. Every
rule in [`spec/contracts.md`](spec/contracts.md) is enforced by real code and
proved by a runnable check. Three things are seams rather than integrations, and
are marked as such below.

```bash
node serve.mjs --seed   # start the host, seeded, with a fleet token printed
node demo.mjs           # narrated end-to-end walkthrough, 14 steps
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

## Storage: two workspaces, two owners

The split is a privacy boundary, not a convenience.

| | Platform workspace | Employee workspace |
|---|---|---|
| Owner | the platform team | one employee |
| Holds | ledger, registry, grants, platform board, audit, fleet roster | that fleet's board, tool choices, connection descriptor |
| Who can read it | the platform team | that employee only |

Two employees never share a file. The platform team cannot read a fleet board.
The one thing that lives on the platform side despite describing a fleet is the
**roster** (ids, owner, agent ids) — granting invoke to *a named agent inside a
named fleet* requires the platform to be able to address that agent.

## Run the host

```bash
node serve.mjs --seed
```

Serves the three endpoints a connection descriptor names, on `node:http`, no
dependencies. `--seed` builds a fresh world — two enterprise agents onboarded, two
outputs published, one fleet registered — and prints a fleet token with curl
examples.

```
  ledger          http://127.0.0.1:8080/ledger
  gateway         http://127.0.0.1:8080/gateway
  platform_board  http://127.0.0.1:8080/board
```

**Identity comes from the token, never from the request.** A token is issued per
fleet and carries both the employee and the fleet id, so a caller cannot name
either. Only the agent id comes from the request, and the host verifies it against
the roster. A body that says `{"employee": "someone-else"}` is simply acting as
itself — that field is not read.

This is the piece a platform team replaces with the same routes on infrastructure
they already run. The routes and the checks are the contract; this process is not.

## The transport is not ours

The person building a fleet installs whatever MCP components their harness
provides. This repo does not implement or start a transport. What it does instead:

1. **asks which tools the fleet wants**, and sorts them into what the employee
   already has via their harness (no grant needed — it authenticates as them)
   versus what needs the platform team's say-so
2. **emits a connection descriptor** naming the ledger, gateway and platform-board
   endpoints, which the fleet builder points their harness at

The platform board is reached over a URL or linked directly in-process — the same
two methods either way, so a fleet cannot tell the difference. `handler.mjs` is a
pure request handler the platform team mounts on a server they already run.

## Layout

Four trees. The dependency direction is the point: both fleets depend on the
brain; the brain depends on neither, and contains nothing harness-specific.

```
brain/                  the ledger and everything harness-agnostic (D12)
  schema.mjs            the output object; a vendor adapter target
  scope.mjs             the scope lattice and intersection
  ledger.mjs            append-only store, computed scope, cascade, tombstones
  provenance.mjs        derived_from graph, descendants, conflicts
  query.mjs             the consume path: two checks, cites provenance
  board.mjs             Mission Control: items, lanes, statuses, append-only threads
  identity.mjs          ── SEAM: the IdP. Local provider; stores nothing.
  audit.mjs             everything crossing the fleet boundary
  telemetry.mjs         usage → deprecation candidates
  gates.mjs             status from a check that can fail

platform-fleet/         owned and governed by the platform team (D1)
  registry.mjs          agent manifests, scope review, lifecycle
  fleet-roster.mjs      the one shared fact about a fleet: its addressable agents
  grants.mjs            time-boxed invoke grants
  gateway.mjs           the only enforcement that counts (D13)
  board.mjs             thin review queue (D19); same thread grammar
  handler.mjs           mountable board handler — two routes, no enumeration
  host.mjs              serves /ledger, /gateway, /board; identity from the token
  tokens.mjs            ── SEAM: token -> { employee, fleet }
  connectors/           ── SEAM: ServiceNow / Agentforce / Copilot adapters

employee-fleet/         self-serve, free to create (D2)
  tools.mjs             which tools the fleet wants; the connection descriptor
  platform-link.mjs     direct or URL — the board cannot tell which
  enforce.mjs           advisory local check — worthless against intent
  board.mjs             private cockpit; a verdict authorises, and publishes an output

kit/skills/             what an employee installs — six skills, one file each
spec/contracts.md       the Phase 0 contracts
workspace.mjs           storage ownership: platform vs employee
acceptance/run.mjs      60 checks, one per exit test or decision
wire.mjs                buildPlatform() and buildFleet()
serve.mjs               start the host
```

## The three seams

Everything else is real. These three are interfaces with a local implementation
behind them, because none of them can exist on a laptop:

| Seam | What is real | What to swap in |
|---|---|---|
| **Identity** (`brain/identity.mjs`) | The provider contract, and the invariant that the brain re-resolves on every call and **persists no entitlements** — proved by a check that walks every stored record | A real IdP client. `resolve(employeeId) → { id, status, entitlements }` is the whole surface. |
| **Connectors** (`platform-fleet/connectors/`) | The normalise-to-schema contract, the `auth_mode` declaration that drives scope review, and read-vs-write op classification that forces approval | A real vendor client in `call()`. `normalise()` does not change. |
| **Tokens** (`platform-fleet/tokens.mjs`) | That a token binds employee *and* fleet, that it is re-read on every request, and that revocation and offboarding both take effect immediately | Whatever mints your tokens — OIDC, an internal STS, mTLS identity. `resolve(token) → { employee, fleet }` is the whole surface. |

Swapping any of them is a config change. Nothing above those files moves.

## The two boards are different products

Not one component instanced twice (D9).

| | Fleet Mission Control | Platform Mission Control |
|---|---|---|
| Operator | one employee | a team, with assignment |
| Item subject | my own work | someone else's request |
| Item lifecycle | six work statuses, in lanes | open → in review → closed |
| An item does | publishes an output to the ledger | changes a grant, scope or lifecycle |
| Audit | private, unaudited | every decision is an audit record |

What they **do** share is the thread. The same append-only entries in the same
six kinds — `instruction`, `proposal`, `decision`, `note`, `report`, `change` —
defined once in `brain/board.mjs`. One vocabulary, two boards: somebody who can
read one can read the other, which was not true when each invented its own
states.

They share exactly one *interface*: a grant request leaves the fleet board,
becomes an item in the platform queue, and the decision returns as a status on
the requester's own item (D18). Neither side can read the other's board.

### What an item looks like

An item carries a **lane** (which agent owns it), a **kind**, and a **status**
that describes where the *work* is rather than where the conversation is:

| Status | Shown as | Means |
|---|---|---|
| `now` | In flight | moving, ball is with us |
| `blocked` | Blocked | something must break first |
| `waiting` | Waiting on | ball is with someone else |
| `parked` | Parked | deliberately not now |
| `done` / `shipped` | Done / Shipped | finished, off the default board |

Keeping the two apart is the change that makes a board readable. "Proposed" is a
fact about a conversation; "Blocked" is a fact about the work, and an item can be
blocked with nothing pending at all.

Parking and archiving are both **lossless**: `parkedFrom` remembers the status an
item held, so unparking a parked `waiting` item returns it to `waiting` and not
to `now`, and an archived item keeps every field so restore is total. Nothing is
ever deleted.

A field change is itself a thread entry, written by the board and never by hand,
so an item can always say how it got here.

### A verdict authorises; it does not execute

Approving a **plan** records approved intent and runs nothing — the agent carries
it out in its own next session and posts a `report` on the same thread. Approving
a proposal that carries a **candidate output** publishes it, because publishing is
the act being authorised. The board writes the report either way, so both read
identically.

A proposal has to be answerable before it can carry a verdict: an understanding,
at least one concrete action, what it needs, what it will deliberately not do,
and where the reply came from (`agent`, `summary` or `offline`). A one-line
assurance is refused, because there is nothing in it to approve.

The platform board ships **thin** (D19) — items, assignee, decision, audit record.
SLAs, standing recurring reviews and conflict adjudication are Phase 6, specified
from what the team was actually doing by hand. An acceptance check asserts those
fields are still absent, so the deferral stays honest.

## What the acceptance suite proves

60 checks, grouped by the phase whose exit test they are.

| Phase | Proves |
|---|---|
| 1 | cascade invalidation; scope cannot be widened by its producer; harness sources floor at fleet-private; tombstone-plus-cascade; departed signers frozen |
| 2 | two employees, same question, correctly different answers; provenance and status on every answer; **no entitlement stored anywhere in the brain**; a former employee is refused |
| 3 | onboarding takes a manifest and a review and no platform code; scope review blocks org-wide over a service account; the same agent publishes as platform-internal; retiring marks outputs stale; the board is still thin |
| 4 | a fleet consumes on first run with zero manual grants; an ungranted invoke is refused by the gateway; **disabling the local check changes nothing**; approve is the publish gate; nobody drives someone else's board |
| 5 | granted invokes, identical ungranted refused, both audited; every vendor write terminates at a human; the gateway sheds rather than passing a stampede; revocation is immediate; the boards share only the grant request |
| 6 | status comes from a check that can fail; telemetry surfaces unused agents; conflicting answers are surfaced, never resolved |
| Mission Control | an item carries a lane, a kind and a work status; a lane must be a registered agent; a proposal without concrete actions is refused; **a verdict on a plan publishes nothing, a verdict on a candidate publishes exactly one output**; a proposal cannot be decided twice; a field change is an entry and cannot be forged; park and archive are both lossless; every write bumps a revision; what waits on me and what waits on an agent are two different queues; both boards speak the same thread grammar |
| Workspaces | employee and platform storage are separate trees; two employees never share a file; tool selection sorts harness from enterprise; the descriptor names all three endpoints; the URL link behaves identically to the direct one; **the URL route cannot be walked to read someone else's request** |
| Host | health is open and everything else needs a live token; **a body-supplied employee id is ignored and a body-supplied fleet id cannot be borrowed**; an unregistered agent is refused first; publishing over the wire still computes scope and forces the signer; an approval cannot name another approver; revocation and offboarding are immediate; an archived fleet cannot act; a 500 leaks nothing |

A phase that cannot pass its check has not shipped, whatever the code says.

## Known gaps

Honest list, in the order they would bite.

1. **Single-process, file-backed.** The ledger is JSONL folded in memory. Correct
   and inspectable; not concurrent. A real deployment needs a database with the
   same append-only semantics — the `Ledger` interface is what to preserve.
2. **No real IAM or vendor tenancy.** See the seams above.
3. **Fleet-board privacy is a path split plus an owner check.** Two employees have
   separate files, which is the right shape, but nothing stops a process with
   filesystem access from reading another workspace. Real isolation is per-tenant
   storage with its own credentials.
5. **No human UI.** Both boards are libraries over JSON files reached through the
   host. Nobody can *open* either one — a person interacting with the brain still
   needs a surface built. This is the largest remaining gap.
6. **The host is HTTP on localhost with no TLS, CORS, or request limits.** Fine
   behind a reverse proxy that terminates TLS and rate-limits by IP; not fine
   exposed directly.
7. **Load shedding is a per-minute rate limit and an in-flight cap**, and the
   counters are per-process. Real shedding needs a queue with priorities and shared
   state across instances.
8. **`conflicts()` compares `body.value` by identity.** Real conflict detection
   needs per-kind comparators.
9. **Subscriptions (component 16) are still not built.**
