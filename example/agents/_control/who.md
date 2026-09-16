# Who — the people who must never be misplaced  (EXAMPLE — fictional)

For each: **role, the channel they actually reach Jane Doe on, and the one thing that gets
them wrong.** A miss here is a failure of the brief, not a degradation of it. When in doubt
whether someone is leadership, treat them as if they are.

| Person | Role | Reaches Jane on | The thing that gets it wrong |
|---|---|---|---|
| **Marcus Vale** | COO, Acme Corp | Chat | Goes **first**, ahead of everyone; never batched into a group line |
| **Priya Raghunathan** | Jane's direct manager (CTO) | Email | Naming Jane in the body is never optional — if Priya writes "Jane, can you…", it is surfaced verbatim, not summarised |
| **Dan Okafor** | VP Platform, sponsor of the Atlas program | Email | New replies hide behind old messages on long threads — open the thread, read the newest by date |
| **Lena Brandt** | Acme's largest customer contact (external) | Email | External: any reply signs as Jane Doe, Acme Corp — never as an agent |

**Never-miss sweep (run every brief/check):**

1. Sender query, window ≥ the brief's:
   `{from:marcus.vale OR from:priya.r OR from:d.okafor OR from:lena.brandt} newer_than:3d`.
2. For every thread returned, open it and read the **newest message by date** — do not trust
   the search result's message list (see `environment.md`, mail API gotcha).
3. Report every hit even if the ask lands on someone else; **being named is the signal.**

> Fictional. Replace every row with your own before use — a wrong channel here is worse than
> an empty table, because it is trusted.
