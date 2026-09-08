# Enterprise Brain

A portable **control plane** for a fleet of AI-employee agents in Claude Code. The org
layer *above* a single chief-of-staff orchestrator: it owns the roster, the routing table,
the fleet-wide rules, and — the part most fleets get wrong — a **per-agent memory model**.

It is the companion to the [orchestrator-agent-kit](https://github.com/aviralmathur/orchestrator-agent-kit).
That kit builds one orchestrator and teaches how a single agent *behaves*. This kit builds
the plane a *fleet* of them sits on, and does not repeat the behaviour rules.

## What it gives you

- **Routing** — "who should do this?" becomes a lookup, not a guess. Misrouted work is the
  most expensive waste in a fleet; the control plane single-homes the work→lane mapping.
- **Per-agent memory** — instead of one flat store every agent loads, each agent gets a
  private namespace + a small shared `_shared/` core, an `owner:` frontmatter contract, and
  read/write-path rules. Adoptable **on top of an existing flat store without moving a file
  on day one** (lazy migration).
- **Governance** — four org-level prime directives: routing is single-homed, memory writes
  are scoped, identity never crosses lanes, the control plane stays small and current.

## Install

1. Copy this folder into your skills directory (e.g. `~/.claude/skills/enterprise-brain`).
2. Replace the placeholders in `SKILL.md` §0 (`{{BRAIN}}`, `{{PRINCIPAL}}`, `{{ORG}}`,
   `{{BOARD}}`, `{{MEM_ROOT}}`, `{{AGENTS_ROOT}}`).
3. Create the control plane and memory tree from `templates/` (see `SKILL.md` §7).
4. Invoke with your brain's name, "route this", "which agent", "add an employee", or a
   question about how memory is stored.

## Layout

```
enterprise-brain/
  SKILL.md      ← the whole control plane (routing §5, memory §4, governance §6)
  README.md     ← this file
  templates/
    roster.md              ← who exists, what they own, identity, namespace
    routing.md             ← work→lane table + confusable-pairs
    how-we-work.md         ← fleet-wide rules
    who.md                 ← the never-miss people
    environment.md         ← machine/tool constraints
    MEMORY.md              ← sectioned memory index
    memory-file.md         ← a memory with the owner: contract
    agent-pointer-SKILL.md ← a specialist's pointer skill
```

## The one-paragraph mental model

A **specialist agent** = pointer skill (decides *if* it fires) → charter (decides *how*) →
its own memory namespace (what *it* knows). The **brain** = a router and a librarian above
them: it reads the control plane, sends each request to the right lane, composes across
lanes when needed, and keeps memory namespaced so no agent drowns in the others' notes. It
never becomes the specialist — it dispatches.
