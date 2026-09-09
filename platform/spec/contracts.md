# Phase 0 contracts

These are the decisions everything downstream hardcodes. Security signs this
before any gateway code exists — retrofitting an authorization model is a rewrite.

## 1 · The access rule

```
may consume output O   ⟸   employee ∈ access-list( producer of O )        [enterprise producers only]
                       ∧   employee ∈ scope( O )

may invoke agent X     ⟸   employee ∈ access-list( X )
                       ∧   a live, time-boxed grant exists on the calling agent

scope( derived output ) =   ∩ scope( its inputs )        ← computed by the ledger
```

Vendor-side entitlement is **deliberately absent**. It is settled once, at
onboarding, when the agent's scope is reviewed (D5). The brain never
re-implements a vendor's permission model.

The consequence: **the agent is the unit of access control**, so an agent's reach
*is* its blast radius. That is why narrow scoping is an onboarding standard (D6)
rather than a convention.

An output published by an **employee fleet** has no access list — it is governed by
its scope alone, which is fleet-private unless the approve gate widened it.

## 2 · The output object

| Field | Meaning |
|---|---|
| `id` | stable identifier |
| `kind` | output type; quality gates register per kind |
| `producer` | `{ fleet, agent, identity }` — who made it and who signs it |
| `body` | `{ subject, value }` plus whatever the kind needs |
| `sources` | `[{ system, ref, harness }]` — systems of record actually touched |
| `derived_from` | ids this was built on. **The edge the cascade runs on.** |
| `supersedes` | the output this replaces |
| `as_of` / `ttl_seconds` | when it was true, and when it stops being quotable |
| `status` | `verified` / `gated` / `unverified` — set by a runnable check, never claimed |
| `scope` | **computed by the ledger**, never accepted from the producer |
| `state` | `live` / `stale` / `tombstoned` / `frozen` |
| `signer_state` | `active` / `former` (D16) |

Two fields are written by the ledger and are read-only to producers:
`scope` and `state`. An attempt to declare a scope is preserved as
`scope_declared_by_producer` so the override is auditable.

The schema is a **vendor adapter target** (D12): a ServiceNow, Agentforce or
Copilot payload is normalised into this shape by its adapter, and the ledger —
not the adapter — decides its scope.

## 3 · The scope lattice

```
{ type: 'fleet', fleet }        one employee's private fleet     ← floor
{ type: 'list', members: [] }   a named set of employees
{ type: 'org' }                 everyone                          ← ceiling
```

Intersection rules: `fleet` dominates everything (two different fleets intersect
to nobody); `org ∩ list = list`; `list ∩ list` = set intersection.

**A harness-connector source floors the scope at the producing fleet (D11).** An
output built on the employee's own mail or tickets has no upstream ledger entry,
so an intersection over its inputs would be *unbounded* rather than narrow.
Without this rule the ledger would compute org-wide, which is the laundering path
by another door.

## 4 · Asymmetric trust

```
enterprise fleet  ──── outputs ────▶  employee fleets     open, scope-filtered
enterprise fleet  ◀─── gated ─────   employee fleets      approve gate in the path
```

Employee fleets read down freely. Writing up always passes a gate. The enterprise
fleet does not trust employee fleets: anyone may build one, and one injected
document in an unvetted fleet must not become an enterprise-wide fact.

## 5 · The promotion gate

A **verdict** on the employee's own Mission Control is the publish action (D9),
and it is the only path to the ledger. Approving does not widen anything — the
ledger still computes the scope — it only lets the output through. The employee
is the accountable signer.

A verdict authorises; it does not execute. Approving a *plan* records approved
intent and runs nothing: the agent carries it out in its own next session and
posts a `report` on the same thread. The exception is the one that matters here —
a proposal carrying a **candidate output** publishes on approval, because
publishing is the act being authorised. Both cases read identically on the
thread, which is how the board stays honest about the difference between "I said
yes" and "it happened".

A proposal must be answerable before it can be decided: an understanding, at
least one concrete action, what it needs, and where the reply came from. A
one-line assurance cannot carry a verdict, because there is nothing in it to
approve.

A widening request routes to the owner of the narrowest input, never to the
requester.

## 6 · Enforcement

**The gateway is the only enforcement that counts (D13).** Harness permission
modes can be switched off by the person they constrain, so the local enforcement
point is advisory and defence-in-depth. Every access decision is re-evaluated
server-side on every call; the client is never trusted to have already checked.

Every **vendor write** terminates at a human approval. This is also what breaks
the injection chain: hostile content → employee's agent → vendor write.

## 7 · The two manifests

**Enterprise agent** — reviewed by the platform team before publication:
`id`, `dri`, `produces[]`, `cadence`, `connectors[{system, auth_mode}]`, `scope`,
`employee_reachable`, `invocable`, `rate_limit.per_minute`, `quality_gate`,
`deprecation_policy`.

Onboarding **blocks** on org-wide scope over a service-account connector: every
employee on the access list would otherwise see everything that account can see.
The remedy is a narrower scope, or `employee_reachable: false` so the agent stays
platform-internal and its outputs are published instead.

**Employee fleet** — self-serve, unreviewed: `fleet`, `owner`, `harness`,
`agents[{id, purpose}]`. Registration exists because granting invoke to *a named
agent inside a named fleet* requires the enterprise to be able to address that
agent.

## 8 · Invariants the platform must never break

1. **No entitlement is stored in the brain.** It resolves live from the IdP on
   every call. The moment access lives here, you own a permissions database and
   an offboarding defect.
2. **No employee-reachable service account.** The one exception becomes the
   architecture.
3. **A small platform team is sufficient.** If a phase implies a delivery pod per
   business unit, it is a consulting engagement wearing a platform's name.
