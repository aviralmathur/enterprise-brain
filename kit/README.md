# The employee fleet kit

What an employee installs to run a fleet against the Enterprise Brain. Six skills,
one file each, deliberately separate so a fleet can install only what it needs.

| Skill | Owns | Does not |
|---|---|---|
| [`fleet-setup`](skills/fleet-setup/SKILL.md) | Register the fleet, ask which tools it wants, emit the connection descriptor | Read, publish or invoke |
| [`fleet-consume`](skills/fleet-consume/SKILL.md) | Read the ledger; report freshness, status and provenance; surface conflicts | Invoke or publish |
| [`fleet-publish`](skills/fleet-publish/SKILL.md) | Propose then approve, which is the publish gate | Set an output's scope — the ledger computes it |
| [`fleet-access`](skills/fleet-access/SKILL.md) | Raise access and grant requests; check your own status | Grant anything, or see the platform queue |
| [`fleet-invoke`](skills/fleet-invoke/SKILL.md) | Call an enterprise agent; get a human yes for every write | Hold a vendor credential |
| [`fleet-board`](skills/fleet-board/SKILL.md) | The private cockpit and its fixed thread shape | Leak the board's contents into anything published |

## Install

```bash
cp -r kit/skills/* ~/.claude/skills/
```

Then run `fleet-setup` once. It registers the fleet and writes
`connection.json` into the employee's own workspace.

## The transport is yours

These skills do **not** implement MCP or any other transport, and will not offer
to. The person building the fleet installs whatever components their harness
provides and points them at the three endpoints in `connection.json`:

- `ledger` — the read path. Cheap, direct, no gateway.
- `gateway` — the only write path up, and the only authoritative check.
- `platform_board` — the platform team's Mission Control, a URL away.

## Two things every skill assumes

**Consume is filtered by the reader's own entitlements.** Two people running an
identical fleet get different answers to the same question. That is correct, and
it will look like a bug the first time someone reports it.

**The gateway re-checks everything.** A local check being disabled changes nothing
about what a fleet can reach. Nothing in a fleet should be written as though its
own check were authoritative.

## Storage

Everything a fleet holds lives in that employee's own workspace — board, tool
choices, connection descriptor. Two employees never share a file, and the platform
team cannot read any of it.

The one exception is the fleet roster (ids, owner, agent ids), which is stored on
the platform side because granting invoke to a named agent requires the platform to
be able to address it.
