# Memory model — where each agent's knowledge lives

Part of the control plane. Every agent reads this; **{{BRAIN}}** owns it. The full rationale
and the failure modes are in the enterprise-brain SKILL §4 — this file is the runtime contract.

The failure it prevents: **one flat store, shared by everyone, that only grows.** Every agent
loads every note, 90% is noise to any given agent, and a stale line survives because no single
agent owns the cleanup. The fix is namespaces + a small shared core + an index + an ownership
contract.

---

## Layout

```
{{MEM_ROOT}}/
  MEMORY.md            ← the index. Sectioned: ## Shared, then ## <Agent> per agent.
  _shared/             ← facts EVERY agent needs. Small, capped (see Budget).
    identity.md        ← who signs as what; the identity boundary
    environment.md     ← machine/tool constraints
    who.md             ← the never-miss people
    <fleet-rule>.md    ← standing rules true for the whole fleet
  <agent>/             ← one folder per agent. Its private memory.
    <fact>.md
  _unassigned/         ← migration holding pen. Loaded globally until triaged.
  <librarian>/         ← the knowledge lane. Paged in on demand, never auto-loaded.
```

---

## The ownership contract

Every memory declares exactly one owner in its frontmatter (shape: `memory-file.md`):

```yaml
owner: <agent> | shared
```

- **`owner: shared`** is reserved for facts *every* agent needs — identity/signing,
  environment, the never-miss people, standing rules that bind the whole fleet. It is
  expensive: it loads everywhere. It is capped. **Earn it.**
- **`owner: <agent>`** is the default. Lives in that agent's namespace; loads only when that
  agent runs.
- A fact two agents need is **not duplicated.** Either it is genuinely fleet-wide (promote it
  to `shared`, once) or it belongs to one agent and the other reads it when they collaborate.

`shared` and `<agent>` are the only valid values. There is no `fleet` value — "fleet" is the
collective noun for the agents, never a folder and never an `owner:`.

---

## Read path

- **A specialist agent reads:** `_shared/` **+** its own `<agent>/` namespace **+** the
  `## Shared` and `## <that agent>` sections of `MEMORY.md`. Nothing else.
- **{{BRAIN}} reads:** `_control/` **+** the full `MEMORY.md` index — routing needs to know
  what every lane knows. Individual agent files only when a cross-agent question needs them.
- **`_unassigned/`** is read by everyone until it is emptied. That cost is what makes people
  finish the migration.
- **The librarian's folder is never auto-loaded** — it is paged in on a query or an explicit
  read, which is what lets it grow without bound.

> **Discipline, not a mechanism.** Nothing in the harness enforces section-scoped loading of
> `MEMORY.md` — it is one file and it loads whole. "Reads only its own section" is a rule the
> agent follows, not a guarantee the loader provides. This is why the *whole index* is budgeted
> (one hook line per note), not just the `## Shared` section. Per-file isolation is real: an
> agent genuinely never opens another agent's notes.

---

## Write path

- An agent **writes, updates and deletes only within its own namespace**, and may **propose**
  a `_shared/` addition.
- Only **{{BRAIN}}** — or an explicit fleet-wide instruction from {{PRINCIPAL}} ("from now on,
  every agent…") — writes `_shared/` and `_control/`. This is what stops one agent quietly
  changing a rule the whole fleet runs on.
- **Check for an existing file before writing** — in the owner's namespace and in `_shared/`.
  Update it rather than create a near-duplicate. Delete memories that turn out wrong.
- **Provenance stays.** Keep `modified` and the origin session id. A memory reflects what was
  true when written; if it names a file, flag or figure, verify it still holds before acting.
- **Concurrency is not handled.** Two sessions writing the same file last-write-wins. Relevant
  when scheduled/unattended runs share a namespace — sequence them.

---

## Budget

`_shared/` is the always-on tax: it loads on every session of every agent.

> **Budget: {{BUDGET}} total.** Full is full — **adding means demoting** something into an
> agent namespace.

The `MEMORY.md` index is budgeted too, for the same reason (it loads whole regardless of lane):
one line per note, no content.

Per-agent namespaces are not capped, but each is subject to periodic consolidation — merge
duplicates, prune stale, fix the index. Run it **per agent**, never across the whole store, so
the job stays small enough to finish.

---

## Lazy migration — adopting over an existing flat store

You do not stop the world. The flat `MEMORY.md` keeps loading the entire time.

1. **Create the tree empty** — `_shared/`, `_unassigned/`, a folder per agent. Move nothing.
2. **New memories are born namespaced** — every new file gets an `owner:` and lands right.
3. **Re-file on touch** — when you next read or update an old flat memory, give it an `owner:`
   and move it. Only files you were already touching.
4. **Infer owner when re-filing:** agent name in the slug/description → that agent; identity /
   environment / people / fleet-wide rule → `shared`; a topic clearly in one lane → that agent;
   genuinely unclear → `_unassigned/` (still loaded globally, so nothing is lost) until triaged.
5. **The index grows sections, not churn** — old flat lines stay under `## Unfiled` until their
   file is re-filed.
6. **Optional reconcile, one agent at a time** — when an agent's namespace matters, sweep the
   flat store for its notes in one sitting. **Never a big-bang sort of all files at once** —
   that is how ownership gets guessed wrong at scale.

The end state and the starting state run the same loader. That is what makes it safe to go slow.

---

## The knowledge layer (third tier)

`_shared/` and `<agent>/` are *operational* memory — what an agent needs to act. Durable facts
about the world (people, orgs, tools, concepts) that many lanes draw on go to the **librarian's
own lane** instead: not `_shared/` (it would blow the always-on budget) and not one agent's
namespace (then no one else finds it).

Flat notes, single writer, every claim cites its source, paged in on demand. The contract for
that lane lives in the librarian's own skill — see `cerebro/SKILL.md`, which owns it.
