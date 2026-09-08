# Known issues / tracked follow-ups

Small, honest list of things to reconcile before (or shortly after) a wider release.

## Open

### 1 · Placeholders in the shipped skills
`{{BRAIN}}`, `{{PRINCIPAL}}`, `{{ORG}}`, `{{MEM_ROOT}}`, `{{AGENTS_ROOT}}` are intentional —
adopters search-and-replace them. Consider a tiny `init` script that prompts for each and
fills them in, so first-run is one command.

### 2 · Example fleet is minimal
`example/` shows Alfred (filled charter) + roster + routing + two memory notes. Athena and
Scout have roster/routing rows but no charters or notes yet. Flesh them out if a fuller
worked example helps adopters.

## Resolved

### ✅ Memory-model naming drift (`_fleet/` → `_shared/`)  — reconciled 2026-09-08
The shared-core folder is now named **`_shared/`** everywhere (SKILL, templates, example),
and the ownership tag is **`owner: shared`**. This removes the collision with the "fleet =
every agent" wording. "Fleet" survives only as the collective noun ("the fleet", "fleet-wide
rules"), never as a folder or an `owner:` value.

### ✅ Librarian: flat notes vs the wiki taxonomy  — reconciled 2026-09-08
The librarian (**Cerebro**) writes **flat notes in its own `cerebro/` folder** — no
`wiki/{sources,entities,concepts,synthesis}` taxonomy. The per-agent folders are the
structure; wikilinks are a convenience. `cerebro/SKILL.md` (§3 query, §4 lint, §5 note shape)
and `enterprise-brain/SKILL.md` §4.7 all describe the flat model consistently. The LLM-Wiki
*pattern* (ingest → provenance → cross-links) is kept; the separate taxonomy is dropped.
