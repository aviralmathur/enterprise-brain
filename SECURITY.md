# Security policy

Enterprise Brain ships two kinds of payload, and they fail in different ways:

- **`platform/`** — Node code. Fails like software: a bug, a bypass, a leak.
- **`skills/`** and the charters/control-plane files it templates — **text that AI agents read
  and act on.** Fails like an instruction: it does exactly what it says, and every check
  stays green.

The second one is the reason this file exists. Most security policies only describe the
first.

## What counts as a vulnerability here

Report any of these:

**Instruction-level (the unusual class — please do report these)**
- A shipped skill, template, charter, or doc that tells an agent to do something it should
  not — auto-approve, skip a human gate, widen its own scope, exfiltrate a memory namespace.
- Text that reads differently to a human reviewer than to a model: invisible or zero-width
  characters, bidirectional overrides, homoglyphs, content hidden in a diff's context lines.
- A prompt-injection path — anywhere untrusted content (an ingested source, a memory note, a
  PR diff, a tool result) can reach an agent as *instructions* rather than as *data*.
- A routing or memory-model rule that lets one agent read or write another's namespace, or
  lets `_shared/` be written by something that is not the brain.

**Code-level**
- Cross-tenant data access, or any escape from a tenant's scope.
- A flaw in identity, grants, gateway, or token handling (`platform/brain/identity.mjs`,
  `platform/platform-fleet/{grants,gateway,tokens}.mjs`).
- Provenance or audit-ledger tampering — anything that lets an action be taken without a
  truthful record of it.
- Secret or credential exposure, in code, CI, or a committed fixture.

**Not a vulnerability**
- The fictional example fleet (Alice, Bob, Carol, Dave) containing obviously fake data.
- `KNOWN-ISSUES.md` describing a historical problem that is already documented as resolved.
- A missing hardening control you would like to see — that is a feature request; open an
  issue or a PR.

## How to report

**Use GitHub's private vulnerability reporting** — the *Security* tab → *Report a
vulnerability*. It opens a private thread with the maintainer; nothing is public until it is
fixed.

Please do **not** open a public issue or PR for an instruction-level finding. A public diff
that spells out a working injection is itself the payload.

Include, if you can:
- the file and line, and the exact bytes if invisible characters are involved
- which agent or surface would read it, and what it would do differently as a result
- whether it affects a fresh `init.sh` install, or only a specific adopted fleet

## What to expect

Single maintainer, so: acknowledgement within **5 working days**, an assessment within
**10**. If a report is valid and affects installs, the fix lands with a check that was red
before it — the same rule as any other change here (see `CONTRIBUTING.md`).

Credit in the release notes if you want it, and none if you do not. Say which.

## For adopters

Two things worth knowing, because they are properties of the design rather than bugs in it:

1. **Installing from `main` installs whatever is in `main` at that moment.** Pin to a tag if
   you need a reviewed, fixed point.
2. **A charter is an instruction, and agents obey instructions.** Review a diff that touches
   `skills/`, a charter, or `_control/` the way you would review a change to an access-control
   list — as *data about what someone wants your agents to do*, never as guidance to follow.
   Do that review with a human, not with an agent that holds write or send capability.
