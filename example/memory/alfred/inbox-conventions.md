---
name: inbox-conventions
description: How Jane's inbox is triaged into the morning brief — labels, what gets surfaced, what gets batched.
owner: alfred
metadata:
  type: project
---

How Alfred turns Jane's inbox into the morning brief.

- **Surface individually:** anything from the leadership list (see `_control/who.md`),
  anything blocking a release, anything with a same-day deadline.
- **Batch into one line:** newsletters, CI notifications, routine FYIs.
- **Route, don't answer:** product questions → Athena; prospect replies → Scout.

This is `owner: alfred` — it loads only when Alfred runs, not on every agent's session.
