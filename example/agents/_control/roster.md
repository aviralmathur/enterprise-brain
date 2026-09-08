# Roster — the Acme fleet  (EXAMPLE — fictional)

Source of truth for **who exists, what they own, who they report to, which identity they
sign as, and where their memory lives**. Jarvis (the brain) reads this first on any
org/routing question. A dead row is trusted and wrong — keep it current.

- **Principal:** Jane Doe — *VP Engineering, Acme Corp*.
- **Brain:** **Jarvis** — the control plane. Routes, composes across lanes, owns this file
  and `routing.md`. Does not do a specialist's work.
- **Orchestrator (default lane):** **Alfred** — chief of staff. Everything without a
  specialist lane lands here.
- **Memory root:** `~/.claude/memory/` · **Charters:** `~/agents/`

| Agent | Owns (single owner of) | Reports to | Identity (signs as) | Memory namespace |
|---|---|---|---|---|
| **Alfred** | Inbox, briefs, triage, delegation, catch-all | → Jane | Alfred internal · Jane/Acme external | `alfred/` |
| **Athena** | Products — roadmap, health, releases, registry | Alfred → Athena | Athena internal · Jane/Acme external | `athena/` |
| **Scout** | Business development — outbound, pursuits | **Jane directly** | Scout internal · Jane/Acme external | `scout/` |
| **Cerebro** | Cross-cutting knowledge — research, patterns, methods; ingests sources; answers "what do we know about X" | Jarvis / Alfred → Cerebro | *never sends — writes only `cerebro/`* | `cerebro/` (single-writer) |

## Identity boundary — read before signing anything
This example fleet is a single identity (Acme). External messages sign as *Jane Doe, Acme
Corp* — never as an agent. **One external recipient makes the whole message external.** If
your fleet spans two identities (e.g. a work org and a personal venture), give each agent's
row its own identity and never let the brain cross them.

## Reporting shape
- **Report to Jane directly** (bypass Alfred): Scout (BD).
- **Routed by Alfred** (the orchestrator): every other agent.
- **Cerebro** is the librarian and the single writer of `cerebro/`; every other agent reads it
  but never writes it, and sends nothing outward.
