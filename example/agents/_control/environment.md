# Environment — constraints that cost an hour each when rediscovered  (EXAMPLE — fictional)

Machine, tool and API facts every agent should know so none relearns them. One line each.
Durable constraints only — not the state of any project.

- **OS / shell:** macOS 15, zsh primary. CI runners are Ubuntu 24.04 — scripts must be
  portable (`sed -i` differs; use the `-i.bak` + `rm` form).
- **Runtime:** Node 22, pnpm. No global installs on the CI image — everything via `pnpm dlx`.
- **Mail API gotcha:** thread search returns the **oldest** 5 messages per thread. Treat the
  result as returning thread IDs only; open each thread and read the newest message by date.
- **Chat API gotcha:** messages are create-only — no edit, no delete. A sent message cannot be
  repaired, which is why a tool limit found mid-send cancels the send (`how-we-work.md`).
- **Paths:** memory root `~/.claude/memory`, charters `~/agents`, board `—` (none in this
  example fleet).
- **Auth:** single identity — `jane.doe@acme.example`. OAuth tokens expire every 7 days;
  a refresh prompt mid-task means stop and tell Jane, never retry silently.
- **Deploy:** the docs site ships by `git push` to `main`; the internal tools ship by file copy
  + `systemctl --user restart` on the box. The second one has no CI, so it is the one that
  goes stale.

Each constraint that has an expiry should carry its date and retire itself.

> Fictional. Replace every line with your own — these are the gotchas *your* fleet keeps
> rediscovering, and the value is entirely in them being true.
