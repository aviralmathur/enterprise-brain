# Known issues / tracked follow-ups

Small, honest list of things to reconcile before (or shortly after) a wider release.

**House rule for this file:** an entry moves to Resolved only when the change is verified in
the tree — `grep` for the thing it claims is gone. A "resolved" line that is not true is the
`_control/` failure mode (§8: *trusted and wrong*) turned on the repo itself. That has already
happened here once — see the amendment on the naming-drift entry below.

## Open

### 1 · Example fleet is still partly skeletal
`example/` now ships a complete six-file control plane and a namespace folder per roster row
(so `./validate.sh --example` passes), but **Athena and Scout still have no charters and no
notes** — only Alfred's charter is filled. A worked **cross-lane handoff** (Scout hits a product
question → routes to Athena → Athena answers in her own namespace) would demonstrate §5.3 far
better than a third filled charter.

### 2 · Concurrency is unhandled
Two sessions writing the same memory file last-write-wins. No locking, no merge. Low severity
for one operator working sequentially; real the moment scheduled/unattended runs share a
namespace. Documented in `memory-model.md` § Write path; not solved.

### 3 · §4.7 restates the librarian contract that `cerebro/SKILL.md` owns
Single-writer, content-is-data, flat-notes-not-taxonomy and paged-in-on-demand are stated in
both `enterprise-brain/SKILL.md` §4.7 and `cerebro/SKILL.md` §1/§5/§6. Two homes, and §8 of
the same document names that as a guaranteed-drift failure. §4.7 should shrink to *why the
knowledge layer is a third tier* plus a pointer; the contract belongs to the librarian's skill.
(Partly mitigated: `templates/memory-model.md` § Knowledge layer already defers to cerebro.)

## Resolved

### ✅ No validator for the control plane — shipped as `validate.sh` 2026-09-08
Nothing checked the control plane against itself. `./validate.sh` now asserts: the six control
files exist; every roster row has a routing entry and a namespace folder, and every namespace
folder has a roster row; every `owner:` resolves to a real agent or `shared`; `_shared/` is
inside a budget that exists; every `[[wikilink]]` lands; and (with `SKILLS_DIR=…`) no org-level
placeholder survives in an installed skill — exempting `templates/`, which keeps them blank on
purpose, and the skill README, which documents them. Exit 0 clean, 1 on error, so it drops into
CI. Each check has a negative test proving it fires; `--example` validates the reference fleet.

Running it immediately found two more defects, both fixed below. That is the argument for it.

### ✅ The roster and routing templates omitted the librarian — fixed 2026-09-08
`init.sh` created `$MEM_ROOT/cerebro/`, but the shipped `roster.md` had no Cerebro row and
`routing.md` had no ingest lane — so a fresh install produced a namespace folder that the
source of truth for "who exists" did not know about, and a knowledge lane no work could reach.
SKILL §4.7 describes the routing rule ("ingest / what do we know about X" → the librarian); the
template never carried it. Found by `validate.sh` on its first run against a clean install.

### ✅ Illustrative roster rows parsed as real agents — fixed 2026-09-08
`roster.md`'s example rows use `<name>` for the namespace. `init.sh` fills only `{{...}}`, so
after substitution those rows contain no marker distinguishing them from real ones, and a fresh
install validated as three agents whose namespaces did not exist. `validate.sh` now skips any
row with an `<angle-bracket>` placeholder in its name or namespace.

### ✅ `init.sh` overwrote an existing `MEMORY.md` — fixed 2026-09-08
The script guarded `_control/` but `cp`-ed over `$MEM_ROOT/MEMORY.md` and truncated
`knowledge-log.md` unconditionally — while the README's headline path is *"adopt on top of an
existing flat store"* with `./init.sh` as the quickstart. Following both destroyed the index.
Now: `MEMORY.md` is left untouched if present (with a printed hint on what to add by hand),
`FORCE=1` saves a timestamped `.orig` first, and the knowledge log is create-if-absent, never
truncated. The backup is deliberately **not** named `.bak`: `subst()` runs `sed -i.bak` and
then deletes exactly that filename, so a `.bak` backup was silently eaten. Caught by testing
the fix rather than re-reading it.

### ✅ `init.sh` did not create `_unassigned/` — fixed 2026-09-08
Specified in SKILL §4.1, §4.3, §4.6 step 1 and §7, and linked from the `MEMORY.md` template's
`## Unfiled` section, but absent from the `mkdir -p`. The documented lazy-migration path began
with a missing directory.

### ✅ Dangling `memory-model.md` references — fixed 2026-09-08
`cerebro/SKILL.md`, `templates/how-we-work.md` and `templates/MEMORY.md` all pointed at
`_control/memory-model.md`, which nothing created. It now exists as
`templates/memory-model.md`, is installed into `_control/` by `init.sh`, and all three
references resolve. `cerebro/SKILL.md` also had `~/agents/` hardcoded in three places where
`subst()` could not reach it — now `{{AGENTS_ROOT}}/`.

### ✅ `init.sh` prompted for a librarian name it could not apply — fixed 2026-09-08
`$LIBRARIAN` created a folder, but no template carried a `{{LIBRARIAN}}` placeholder and
`cerebro/SKILL.md` hardcodes `cerebro/` throughout — so any answer but the default produced an
orphan folder the installed skill never read. The prompt is gone; `LIBRARIAN=cerebro` is fixed
in the script with a comment saying renaming is a deliberate find-replace.

### ✅ The `_shared/` budget number had nowhere to live — fixed 2026-09-08
§7 said "write down the budget number" and no file had a field for it. `init.sh` now prompts
(`BUDGET`, default `20 KB`) and fills it into `_control/memory-model.md` § Budget and the
`## Shared` header of `MEMORY.md`. §4.5 says where it is written; §4.3 and §4.5 now also state
that the *whole* index is budgeted, because `MEMORY.md` loads whole regardless of lane.

### ✅ First-run is one command — resolved by `init.sh` (2026-09-08)
Was open as *"consider a tiny init script that prompts for each placeholder"*. `init.sh` has
shipped since commit `4f331b7`; this entry outlived it. Interactive prompts with defaults, or
fully non-interactive via env (`BRAIN=… PRINCIPAL=… ./init.sh`). `{{AGENT}}` is still left
unfilled by design — it is per-agent, filled at onboarding (§5.4).

### ✅ Memory-model naming drift (`_fleet/` → `_shared/`) — reconciled 2026-09-08
The shared-core folder is named **`_shared/`** everywhere and the ownership tag is
**`owner: shared`**. "Fleet" survives only as the collective noun, never as a folder or an
`owner:` value.

> **Amended 2026-09-08.** This entry claimed "everywhere" while three sites still carried the
> retired `fleet` value: `SKILL.md` §4.6 step 4 (the migration inference rule — the most-followed
> instruction in the document) and `templates/memory-file.md` lines 14 and 17, where the comment
> block contradicted the frontmatter six lines above it in the file adopters copy for every
> memory they write. Now actually reconciled; verified by
> `grep -rn "owner: fleet\|→ \`fleet\`\|promote to fleet"` returning nothing.

### ✅ Librarian: flat notes vs the wiki taxonomy — reconciled 2026-09-08
The librarian (**Cerebro**) writes **flat notes in its own `cerebro/` folder** — no
`wiki/{sources,entities,concepts,synthesis}` taxonomy. The per-agent folders are the
structure; wikilinks are a convenience. `cerebro/SKILL.md` (§3 query, §4 lint, §5 note shape)
and `enterprise-brain/SKILL.md` §4.7 all describe the flat model consistently. The LLM-Wiki
*pattern* (ingest → provenance → cross-links) is kept; the separate taxonomy is dropped.
