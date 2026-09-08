# Example — a fictional 3-agent fleet

A minimal, **entirely fictional** instance so you can see the kit filled in. Company:
**Acme Corp**. Principal: **Jane Doe, VP Engineering**. Brain: **Jarvis**.

Copy the shapes here; replace every name with your own. Nothing in this folder is real data.

```
agents/
  _control/
    roster.md      ← the 3 agents + Jarvis, each with owns / reports-to / identity / namespace
    routing.md     ← work→lane table + confusable-pairs
  alfred.md        ← one filled-in charter (the chief-of-staff / orchestrator)
memory/
  MEMORY.md        ← the index, sectioned by owner
  _shared/         ← the small capped fleet core (one sample fact)
  alfred/          ← one agent's private namespace (one sample note)
  cerebro/          ← the librarian's cross-cutting knowledge (starts empty)
```

The three agents:
- **Alfred** — chief of staff / orchestrator (the catch-all lane).
- **Athena** — product portfolio owner.
- **Scout** — outbound business development.

Plus **Cerebro**, the librarian (ships as its own skill).
