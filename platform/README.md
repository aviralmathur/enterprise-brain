# Enterprise Brain — reference implementation

The sanctioned way for employees to build agent fleets, and the shared ledger
through which those fleets consume what the enterprise's own agents produce.

This is a **working reference implementation**, not a production deployment. Every
rule in [`spec/contracts.md`](spec/contracts.md) is enforced by real code and
proved by a runnable check. Four things are seams rather than integrations, and
are marked as such below.

```bash
node serve.mjs --seed   # the two boards, seeded, with tokens printed
node demo.mjs           # narrated end-to-end walkthrough
node acceptance/run.mjs # the roadmap's exit tests as runnable checks
```

Then open either board. `--seed` prints a link that signs you in:

| Surface | URL | Operator |
|---|---|---|
| Landing | `/` | picks a board, and lists the local tokens |
| Fleet Mission Control | `/fleet` | one employee, private |
| Platform Mission Control | `/platform` | the platform team |

No build step and no dependency install. The pages are three static files and the
token travels in the URL fragment, which never reaches the server.

To let other people open a board without running a server, host it. **Vercel is
the recommended host**: the brain is one pure request handler, so it deploys as
a single function, and Vercel Blob gives it the durable storage a serverless
filesystem cannot. See [`DEPLOY.md`](DEPLOY.md). One step is yours alone and
nobody should ever do it for you: `vercel login` authenticates in your own
browser, and no agent working in this repo should ask you for a Vercel
credential.

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
  store.mjs             ── SEAM: four storage primitives, swappable backend
  blob-store.mjs        ── SEAM: the hosted backend, one document per workspace
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
  host.mjs              serves the boards, the API and /ledger /gateway /board
  tokens.mjs            ── SEAM: token -> { employee, fleet }
  connectors/           ── SEAM: ServiceNow / Agentforce / Copilot adapters

employee-fleet/         self-serve, free to create (D2)
  tools.mjs             which tools the fleet wants; the connection descriptor
  platform-link.mjs     direct or URL — the board cannot tell which
  enforce.mjs           advisory local check — worthless against intent
  board.mjs             private cockpit; a verdict authorises, and publishes an output

routes/                 what the two boards are built on
  fleet.mjs             what a fleet can do, and nothing else
  platform.mjs          what the platform team can do. No route reads a fleet board.

api/host.mjs            the whole brain as one serverless function. The only
                        file in api/, because Vercel makes a function of each.
vercel.json             every path to that one function
seed-hosted.mjs         seed a deployment from your machine, over its own store
DEPLOY.md               hosting it, and the one step only you can take

ui/                     the boards themselves. Three files, no build step.
  index.html            landing: both boards, the local tokens, curl examples
  fleet.html            Fleet Mission Control - the private cockpit
  platform.html         Platform Mission Control - the review desk

kit/skills/             what an employee installs — six skills, one file each
spec/contracts.md       the Phase 0 contracts
workspace.mjs           storage ownership: platform vs employee
acceptance/run.mjs      74 checks, one per exit test or decision
wire.mjs                buildPlatform() and buildFleet()
serve.mjs               start the host
```

## The four seams

Everything else is real. These four are interfaces with a local implementation
behind them, because none of them can exist on a laptop as itself:

| Seam | What is real | What to swap in |
|---|---|---|
| **Identity** (`brain/identity.mjs`) | The provider contract, and the invariant that the brain re-resolves on every call and **persists no entitlements** — proved by a check that walks every stored record | A real IdP client. `resolve(employeeId) → { id, status, entitlements }` is the whole surface. |
| **Connectors** (`platform-fleet/connectors/`) | The normalise-to-schema contract, the `auth_mode` declaration that drives scope review, and read-vs-write op classification that forces approval | A real vendor client in `call()`. `normalise()` does not change. |
| **Tokens** (`platform-fleet/tokens.mjs`) | That a token binds employee *and* fleet, that it is re-read on every request, and that revocation and offboarding both take effect immediately | Whatever mints your tokens — OIDC, an internal STS, mTLS identity. `resolve(token) → { kind, employee, fleet }` is the whole surface. |
| **Storage** (`brain/store.mjs`) | Four synchronous primitives over a swappable backend, and the document backend's whole lifecycle: hydrated before a request, flushed after, one document per workspace, and a **loud failure rather than an empty-looking read** | `brain/blob-store.mjs` is Vercel Blob. `load(name)` and `save(name, doc)` is the entire contract, so Postgres or S3 goes in the same place. |

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

### Opening them

Both boards are single files of vanilla JavaScript over the same API a harness
would use. There is no privileged path: everything a board can do, a `curl` can
do with the same token, which is what makes the API and not the page the thing
under test.

A page is served without a token, because a page is not data. It shows nothing
until one is supplied, and the token arrives in the URL fragment so it never
reaches this process. The landing page can hand out local bearer values, but only
when the host was started with `--seed` or `--dev-tokens`, and only on the
loopback interface. A check proves it is off otherwise.

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

74 checks, grouped by the phase whose exit test they are.

| Phase | Proves |
|---|---|
| 1 | cascade invalidation; scope cannot be widened by its producer; harness sources floor at fleet-private; tombstone-plus-cascade; departed signers frozen |
| 2 | two employees, same question, correctly different answers; provenance and status on every answer; **no entitlement stored anywhere in the brain**; a former employee is refused |
| 3 | onboarding takes a manifest and a review and no platform code; scope review blocks org-wide over a service account; the same agent publishes as platform-internal; retiring marks outputs stale; the board is still thin |
| 4 | a fleet consumes on first run with zero manual grants; an ungranted invoke is refused by the gateway; **disabling the local check changes nothing**; approve is the publish gate; nobody drives someone else's board |
| 5 | granted invokes, identical ungranted refused, both audited; every vendor write terminates at a human; the gateway sheds rather than passing a stampede; revocation is immediate; the boards share only the grant request |
| 6 | every invocable agent has an adapter behind it; status comes from a check that can fail; **a host ships with gates registered, and the seeded world shows both a pass with its evidence and a kind that stayed unverified**; telemetry surfaces unused agents; conflicting answers are surfaced, never resolved |
| Mission Control | an item carries a lane, a kind and a work status; a lane must be a registered agent; a proposal without concrete actions is refused; **a verdict on a plan publishes nothing, a verdict on a candidate publishes exactly one output**; a proposal cannot be decided twice; a field change is an entry and cannot be forged; park and archive are both lossless; every write bumps a revision; what waits on me and what waits on an agent are two different queues; both boards speak the same thread grammar |
| Workspaces | employee and platform storage are separate trees; two employees never share a file; tool selection sorts harness from enterprise; the descriptor names all three endpoints; the URL link behaves identically to the direct one; **the URL route cannot be walked to read someone else's request** |
| Hosted storage | a path maps to its own workspace document and two employees never share one; **a read from a document nobody hydrated fails loudly rather than looking empty**; the whole brain runs on the hosted backend and gives the same filtered answers; only dirty documents are written back; a request hydrates the platform document and one workspace, never more |
| Boards | both boards and the landing page are served as pages; a page needs no token and bakes none in; **the two API surfaces refuse each other's tokens**; the API needs a live token exactly as the endpoints do; a board's items carry a lane and a work status and its two queues stay separate; the local token list is off by default and never answers off the loopback interface |
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
4. **The boards are single-file pages with no tests of their own.** They are
   thin clients over an API that is checked thoroughly, and every action they
   take is reachable with `curl`, but nothing exercises the rendering itself. A
   broken page would not fail the suite.
5. **The host speaks plain HTTP.** Fine behind a proxy that terminates TLS and
   rate-limits by IP, which is what a Vercel deployment gives it; not fine
   exposed directly.
6. **Load shedding is a per-minute rate limit and an in-flight cap**, and the
   counters are per-process. Real shedding needs a queue with priorities and shared
   state across instances.
7. **`conflicts()` compares `body.value` by identity.** Real conflict detection
   needs per-kind comparators.
8. **Subscriptions (component 16) are still not built.**
