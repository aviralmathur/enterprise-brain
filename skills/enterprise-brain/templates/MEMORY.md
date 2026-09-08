# MEMORY — the index

The index loaded to decide relevance. One line per memory: `- [Title](path) — hook`.
Never put memory *content* here. Sectioned by owner. The `## Shared` section loads on every
session; an agent session additionally loads its own `## <Agent>` section; {{BRAIN}} loads
all sections.

## Shared
<!-- owner: shared — capped (see the memory-model budget). Demote to add. -->
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
     namespace on next touch (see memory-model §migration). Loaded globally until empty. -->
- [<legacy title>](_unassigned/<file>.md) — <hook>
