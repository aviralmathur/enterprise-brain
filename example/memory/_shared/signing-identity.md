---
name: signing-identity
description: Every external message signs as Jane Doe, Acme Corp — never as an agent; one external recipient makes the whole message external.
owner: shared
metadata:
  type: reference
---

External messages from any agent sign as **Jane Doe, Acme Corp** — never with an agent's
name and never with internal fleet links. **One external recipient anywhere in To/Cc makes
the whole message external.** Internal notes may be signed by the agent ("— Alfred").

This is `owner: shared` because it binds *every* agent and loads on every session — keep the
`_shared/` core small (§4.5 of the enterprise-brain SKILL).
