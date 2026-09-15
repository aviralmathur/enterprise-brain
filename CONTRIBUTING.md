# Contributing

Enterprise Brain is two things in one repo, and a change usually belongs to one of them:

- **`skills/`** — the personal control-plane kit (markdown skills + `templates/`). Validated
  by `./validate.sh`.
- **`platform/`** — the enterprise reference implementation (Node, no dependencies to run).
  Validated by `platform/acceptance/run.mjs`.

They share a name and an idea, not a codebase. Say which one your change touches.

## The one rule that matters

> A phase that cannot pass its check has not shipped, whatever the code says.

Every behavioural claim in `platform/` is enforced by a runnable check in
`platform/acceptance/run.mjs`, and every rule in the `skills/` kit is asserted by
`validate.sh`. So:

- **A fix comes with a check that was red before it.** Add the failing check first, watch it
  fail, then make it pass. The `Adversarial — cross-tenant integrity` phase is the model: each
  entry names the defect it proves and would fail against the code before the fix.
- **A feature comes with the check that proves it does what the prose says.** If you cannot
  write the check, the prose is not yet true.

## Before you open a PR

```bash
# platform: the acceptance suite must be green
cd platform && node acceptance/run.mjs && node demo.mjs

# kit: the reference fleet must validate against itself
cd .. && bash validate.sh --example

# and no real name may appear in a shipped surface
grep -rniE 'batman|tenarai|<your real fleet names>' skills/ platform/   # must be empty
```

CI runs exactly these three, on Node 18 / 20 / 22. A red suite is a red PR.

## Ground rules

- **No real data.** This repo is public and ships a *generic* kit plus a *fictional* example
  (Alice, Bob, Carol, Dave). Never commit a real fleet, org, person, host, path, or figure —
  `.gitignore` guards `/agents/` and `/memory/`, and the `no-name-leaks` CI job guards the rest.
- **Keep the control-plane files small.** `_control/` and `_shared/` are budgeted on purpose
  (SKILL §4.5). Adding to the always-on set means demoting something.
- **One home per fact.** Routing lives only in `routing.md`; a fleet-wide rule lives only in
  `how-we-work.md`. A rule copied into a second place is a rule that will drift.

## Reporting a defect

An integrity defect in `platform/` (a way one fleet reaches another's data, widens a scope, or
skips a gate) is the most valuable thing you can file. Describe the attack as a sequence of
`ledger` / `gateway` / board calls — ideally as a failing check — and it goes straight into the
adversarial phase.
