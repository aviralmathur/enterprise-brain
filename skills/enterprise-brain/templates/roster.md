# Roster — {{ORG}} agent fleet

The source of truth for **who exists, what they own, who they report to, and which
identity they sign as**. One row per agent. Keep it current — a dead row is trusted and
wrong. The brain reads this first on any org or routing question.

| Agent | Owns (one line) | Reports to | Identity (signs as) | Memory namespace |
|---|---|---|---|---|
| {{AGENT}} | <what this agent is the single owner of> | {{BRAIN}} / {{PRINCIPAL}} | {{PRINCIPAL}} @ {{ORG}} | `{{MEM_ROOT}}/{{agent}}/` |
| _chief-of-staff_ | Inbox, briefs, triage, catch-all | {{PRINCIPAL}} | {{PRINCIPAL}} @ {{ORG}} | `{{MEM_ROOT}}/<name>/` |
| _strategy_ | Bets, kill/park, "where does this go bigger" | {{PRINCIPAL}} directly | {{PRINCIPAL}} @ {{ORG}} | `{{MEM_ROOT}}/<name>/` |
| _bd_ | Outbound business development | {{BRAIN}} | <persona, e.g. personal venture> | `{{MEM_ROOT}}/<name>/` |
| **Cerebro** | Cross-cutting knowledge — ingests sources, answers "what do we know about X" | {{BRAIN}} | *(read-only, never sends)* | `{{MEM_ROOT}}/cerebro/` |

**Notes on the columns:**

- **Identity** is the persona the agent signs outbound work as. A fleet can span more than
  one identity (a work org + a personal venture). The brain never crosses identities.
- **Reports to** — specialists report to the brain; a strategy/advisory agent may report
  to the principal directly. Read-only agents are marked `(read-only, never sends)`.
- **Memory namespace** — the folder under `{{MEM_ROOT}}/` this agent reads and writes.
