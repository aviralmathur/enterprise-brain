# Environment — constraints that cost an hour each when rediscovered

Machine, tool and API facts every agent should know so none relearns them. One line each.
Keep it to durable constraints — not the state of any project.

- **OS / shell:** <e.g. Windows, PowerShell primary; Bash also available — different syntax>
- **Runtime:** <e.g. Node 24, no C++ toolchain — native modules need prebuilt binaries>
- **Mail API gotcha:** thread search returns the OLDEST 5 messages per thread — treat it
  as returning thread IDs only; open each thread and read the newest message by date.
- **Chat API gotcha:** <create-only? no edit/delete? which client can actually send?>
- **Paths:** memory root `{{MEM_ROOT}}`, charters `{{AGENTS_ROOT}}`, board `{{BOARD}}`.
- **Auth:** <which accounts, which identity is default, token TTLs / refresh needs>
- **Deploy:** <how the real thing ships — copy+service? git? — and where it's stale>

Each constraint that has an expiry should carry its date and retire itself.
