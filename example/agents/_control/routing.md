# Routing — work → lane  (EXAMPLE — fictional)

The **only** place work-to-lane mapping is written. Never hardcode a route into a charter.
Jarvis classifies each request here, checks the confusable-pairs list first, then dispatches.

## The table

| The work | The lane |
|---|---|
| A durable, reusable product — roadmap, health, release, registry | **Athena** |
| Outbound business development — a new prospect, a pursuit, a follow-up | **Scout** |
| Inbox / brief / triage / "what did I miss" / anything unowned | **Alfred** (catch-all) |
| "Ingest this / build the knowledge base / what do we know about X" | **Cerebro** |

## Confusable pairs — check before deciding
The boundaries where duplication actually happens. Name the boundary + one example of each
mistake.

- **Athena vs Scout** — *building* the product is Athena; *selling* it outbound is Scout.
  - ✗ "Draft the pitch email to the prospect" → this is Scout, not Athena.
  - ✗ "Is the new release stable enough to demo?" → this is Athena, not Scout.
- **Alfred vs everyone** — Alfred is the catch-all, never a specialist. If a clear lane
  exists, route there; don't let Alfred quietly do Athena's or Scout's job and mis-sign it.

## Rule
Genuinely ambiguous → ask Jane one question. A misroute is more expensive than a ten-second
question.
