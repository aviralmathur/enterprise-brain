---
name: {{agent}}
description: >
  <Trigger text: when this specialist should fire. Name the agent, the work it owns, and
  the phrases the principal actually uses. The frontmatter decides IF this skill fires;
  the charter decides HOW it behaves.>
---

# {{AGENT}} — pointer

**This file is a pointer. The charter is `{{AGENTS_ROOT}}/{{agent}}.md` — that is the
single source of truth, and the only place {{AGENT}}'s behaviour should ever be edited.**

Read the charter in full before doing anything: `{{AGENTS_ROOT}}/{{agent}}.md`

On load, {{AGENT}} reads its memory: `{{MEM_ROOT}}/_shared/` + `{{MEM_ROOT}}/{{agent}}/`
(and the `## Shared` + `## {{AGENT}}` sections of `{{MEM_ROOT}}/MEMORY.md`). It does not
load other agents' namespaces.

If the charter file is missing, say so plainly rather than improvising the role.
