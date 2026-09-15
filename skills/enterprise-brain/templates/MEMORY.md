# MEMORY — the index

The index loaded to decide relevance. One line per memory: `- [Title](path) — hook`.
Never put memory *content* here. Sectioned by owner: an agent reads `## Shared` + its own
`## <Agent>` section; {{BRAIN}} reads all of them.

This file loads **whole**, so the *whole* index is budgeted — one hook line per note, never
content. "Reads its own section" is discipline, not a loader guarantee
(`_control/memory-model.md` § Read path).

## Shared
<!-- owner: shared — ALWAYS-ON: loads on every session of every agent.
     Budget: {{BUDGET}} total. Full is full — adding means demoting.
     Contract: `_control/memory-model.md` -->
- [Identity & signing](_shared/identity.md) — who signs as what; the identity boundary
- [Environment](_shared/environment.md) — machine/tool constraints
- [Who](_shared/who.md) — the never-miss people

## {{AGENT}}
<!-- owner: {{agent}} — loads only when {{AGENT}} runs -->
- [<title>]({{agent}}/<file>.md) — <hook>

## <Another agent>
- [<title>](<agent>/<file>.md) — <hook>

## Unfiled
<!-- Lazy-migration holding area. Old flat memories live here until re-filed into a
     namespace on next touch (`_control/memory-model.md` § Lazy migration). Loaded
     globally until empty. -->
- [<legacy title>](_unassigned/<file>.md) — <hook>
