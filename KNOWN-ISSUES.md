# Known issues / tracked follow-ups

Small, honest list of things to reconcile before (or shortly after) a wider release.

**House rule for this file:** an entry moves to Resolved only when the change is verified in
the tree — `grep` for the thing it claims is gone. A "resolved" line that is not true is the
`_control/` failure mode (§8: *trusted and wrong*) turned on the repo itself. That has already
happened here once — see the amendment on the naming-drift entry below.

**Scope of this file.** These are the `skills/` control-plane kit's issues. The `platform/`
reference implementation keeps its own honest gap list in
[`platform/README.md` § Known gaps](platform/README.md), and its resolved-defect log lives in
the Resolved section below under the *platform* entries.

## Open

### 1 · Example fleet is still partly skeletal
`example/` now ships a complete six-file control plane and a namespace folder per roster row
(so `./validate.sh --example` passes), but **Athena and Scout still have no charters and no
notes** — only Alfred's charter is filled. A worked **cross-lane handoff** (Scout hits a product
question → routes to Athena → Athena answers in her own namespace) would demonstrate §5.3 far
better than a third filled charter.

### 2 · `docs/usage.gif` is stale — pulled from the README 2026-09-15
The hero GIF records an `init.sh` that no longer exists: it shows the removed "Librarian agent
name" prompt, lacks the `BUDGET` prompt, and its memory-tree line omits `_unassigned/`. Rather
than ship a wrong hero, the README no longer references it (the platform board screenshots are
the hero now). The file is still in the tree; re-record it against the current `init.sh` prompt
sequence, then restore the reference — or delete it. Content is otherwise fine (Jarvis / Jane
Doe / Acme Corp, nothing real in it).

### 3 · Concurrency is unhandled
Two sessions writing the same memory file last-write-wins. No locking, no merge. Low severity
for one operator working sequentially; real the moment scheduled/unattended runs share a
namespace. Documented in `memory-model.md` § Write path; not solved.

### 4 · §4.7 restates the librarian contract that `cerebro/SKILL.md` owns
Single-writer, content-is-data, flat-notes-not-taxonomy and paged-in-on-demand are stated in
both `enterprise-brain/SKILL.md` §4.7 and `cerebro/SKILL.md` §1/§5/§6. Two homes, and §8 of
the same document names that as a guaranteed-drift failure. §4.7 should shrink to *why the
knowledge layer is a third tier* plus a pointer; the contract belongs to the librarian's skill.
(Partly mitigated: `templates/memory-model.md` § Knowledge layer already defers to cerebro.)

## Resolved

### ✅ kit · `validate.sh` mis-parsed every roster it was pointed at — fixed 2026-09-16
Two defects in the roster parser, each harmless alone and compounding badly together. Run
against a real 16-agent fleet on Windows, `validate.sh` reported **28 errors, 26 of them
false**; it named namespaces that exist as missing, and called correctly-filed notes unowned.

1. **CRLF.** Rows were split with `body="${body%|}"`. On a CRLF checkout the `\r` sits *after*
   the closing pipe, so the pipe was never stripped, `awk -F'|' '{print $NF}'` returned the
   empty field beyond it, and **the last column — the memory namespace — read back empty on
   every row**. Each row then fell through to `[ -z "$ns" ] && ns="$name"`, silently deriving
   the namespace from the display name.
2. **Space-delimited sets.** `AGENTS` and `NAMESPACES` were space-padded strings tested with
   `*" $x "*` — a shape that cannot hold a value containing a space. Combined with (1), the
   agent `Nick Fury` became two agents, `nick` and `fury`, neither with a namespace on disk.
   A roster of 16 reported 22.

Both were invisible to CI: the runner checks out LF, and every agent in `example/` is a single
word — precisely the case where the fallback in (1) happens to produce the right answer. The
first fleet with a two-word agent name was the first to hit it.

Fixed by parsing each agent into one TAB-separated `name / slug / namespace` record in a
newline-delimited list, stripping `\r` per row, and replacing every space-padded membership
test with an exact-match `in_set`. A third latent defect went with it: `[[wikilink]]`
resolution was a **substring** test, so `[[batman]]` resolved against a note named
`batman-hourly-brief` and a genuinely broken link passed whenever some longer note name
happened to contain it. It is now an exact match.

Guarded by **`./validate.sh --selftest`**, which builds a throwaway fleet with CRLF endings and
a two-word agent name — the two things `--example` structurally cannot carry — and is wired
into CI beside `--example`. It fails against the pre-fix parser and passes against this one.


### ✅ platform · five cross-tenant integrity defects — fixed 2026-09-15
An adversarial review of `platform/` found five ways an unvetted employee fleet could reach
across the tenant boundary through a feature that trusted its input. Each is now fixed, and each
fix ships with an acceptance check that was **red before it** — see the `Adversarial —
cross-tenant integrity` phase in `platform/acceptance/run.mjs` (suite grew 74 → 85).

- **B1 · cross-tenant supersede.** `ledger.publish()` honoured `supersedes` with no ownership
  check, so a fleet-private output could stale an enterprise output and cascade-stale every
  descendant — spec §4 (asymmetric trust) broken by the headline feature. Now a supersede is
  refused unless the publisher's fleet owns the target, and the refusal names the owner to route
  to. `grep -n "supersede refused" platform/brain/ledger.mjs`.
- **B2 · deriving from unreadable inputs.** `computeScope()` never checked that a producer could
  read the parents it declared, so a fleet could inherit a wider scope (or reference confidential
  data) by naming an output it had no access to. The readability check reuses the consume path,
  wired in `platform/wire.mjs`. `grep -n "canConsume" platform/brain/ledger.mjs platform/wire.mjs`.
- **B3 · the scope lattice widened.** `intersect()` returned a fleet scope unconditionally when a
  fleet met a list, *adding* a viewer instead of intersecting. A fleet scope is now the singleton
  `{ owner }`, and a property test compares every computed audience against a brute-force
  intersection. `grep -n "fleetMeets" platform/brain/scope.mjs`.
- **B4 · hosted storage silently lost writes.** The Blob backend swallowed read failures into an
  empty document (which the next flush wrote back over live data), and had no concurrency guard.
  A failed load now throws; a flush uses optimistic concurrency and refuses a stale write. Still
  read-check-write, not atomic CAS — the README and DEPLOY now say "single-writer until real CAS".
  `grep -n "optimistic concurrency\|write conflict" platform/brain/store.mjs`.
- **B5 · unknown vendor ops skipped approval.** The gateway classified any op not in `writes` as a
  read, so an unclassified op reached a vendor with no human approval — fail-open on the injection
  break (spec §6). Now default-deny: an op is a read only if explicitly listed.
  `grep -n "Default-deny" platform/platform-fleet/gateway.mjs`.

### ✅ Author's real agent names leaked into the shipped skills — removed 2026-09-08
The skills carried example folder names taken from the author's own private fleet rather than
from `example/`: `batman/`, `captain-america/` and `photon/` as illustrative lane folders
(`cerebro/SKILL.md` §"Where Cerebro sits" and §2 step 2), "a client *pursuit* is Shuri's, the
*finance figure* is CA/Falcon's" (§7), and `Batman` as the `{{AGENT}}` example in the
enterprise-brain placeholder table. All now read as generic roles — the chief-of-staff's
folder, the finance lane's, the delivery lane's — which works for any adopter and couples the
generic skill to no particular fleet.

Also corrected: `{{BRAIN}}`'s example was `Cerebro`, which in this repo is the *librarian*,
not the brain. Now `Jarvis`, matching `example/` and the usage GIF.

Swept for the rest and found none: no org name, no colleague names, no emails, hosts, IPs or
internal paths anywhere in the tree. `docs/usage.gif` is fictional throughout, verified frame
by frame (a `grep` "match" on it is a two-letter pattern hitting compressed bytes — GIF text is
rendered pixels, not stored strings).

**Still in git history.** These strings exist in all four commits, including the two already
pushed public. Fixing forward removes them from the tip only. Given what they are — comic
character names used as folder examples, no real person, org or secret — a history rewrite and
force-push is probably not worth its cost, but that is a judgement call, not a fact.

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
