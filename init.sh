#!/usr/bin/env bash
#
# enterprise-brain · init
# Fill the org-level placeholders and scaffold a working fleet: the control plane
# (_control/) and the memory tree (_shared/ + the librarian's folder + MEMORY.md).
#
# Usage:
#   ./init.sh                 # interactive prompts (with defaults)
#   BRAIN=Jarvis PRINCIPAL="Jane Doe, VP Eng" ORG=Acme ./init.sh   # non-interactive via env
#   FORCE=1 ./init.sh         # overwrite an existing _control/ and MEMORY.md
#
# Fills: {{BRAIN}} {{PRINCIPAL}} {{ORG}} {{AGENTS_ROOT}} {{MEM_ROOT}} {{BOARD}} {{BUDGET}}
# Leaves {{AGENT}} untouched — that is per-agent, filled when you onboard each one (SKILL §5.4).
#
# Non-destructive by default: an existing MEMORY.md or knowledge-log.md is never overwritten
# (that is the lazy-migration path — SKILL §4.6 — adopting on top of a store you already have).

set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '%s\n' "$*"; }
ask()  { # var  question  default
  local __v="$1" q="$2" def="${3:-}" ans
  if [ -n "${!__v:-}" ]; then return; fi          # already provided via env — keep it
  if [ -t 0 ]; then
    if [ -n "$def" ]; then printf '  %s [%s]: ' "$q" "$def"; else printf '  %s: ' "$q"; fi
    read -r ans || true
  fi
  printf -v "$__v" '%s' "${ans:-$def}"
}
expand() { local p="$1"; printf '%s' "${p/#\~/$HOME}"; }

say "enterprise-brain · init"
say "─────────────────────────"
ask BRAIN       "Name of the control plane (the brain)"        "Jarvis"
ask PRINCIPAL   "Principal (who the fleet works for, + title)" ""
ask ORG         "Organisation"                                 ""
ask AGENTS_ROOT "Where charters + _control live"               "$HOME/agents"
ask MEM_ROOT    "Memory tree root"                             "$HOME/.claude/memory"
ask BUDGET      "Always-on budget for _shared/ (a hard cap)"   "20 KB"
ask BOARD       "Board/tracker command (optional)"             ""
ask INSTALL_SKILLS "Copy skills into a skills dir now? (path, or blank to skip)" ""

# The librarian ships as the `cerebro` skill and its SKILL.md names that folder throughout.
# Renaming it is a deliberate find-replace across skills/cerebro/ — not a prompt, because a
# prompt here would create a folder the installed skill never reads (see SKILL §4.7).
LIBRARIAN=cerebro

AGENTS_ROOT="$(expand "$AGENTS_ROOT")"
MEM_ROOT="$(expand "$MEM_ROOT")"
[ -n "$PRINCIPAL" ] || { say "! PRINCIPAL is required"; exit 2; }

control="$AGENTS_ROOT/_control"
if [ -e "$control" ] && [ "${FORCE:-0}" != "1" ]; then
  say "! $control already exists — set FORCE=1 to overwrite. Nothing changed."
  exit 1
fi

# portable in-place sed (works on both GNU and BSD/macOS)
subst() {
  local f="$1"
  sed -i.bak \
    -e "s#{{BRAIN}}#${BRAIN}#g" \
    -e "s#{{PRINCIPAL}}#${PRINCIPAL}#g" \
    -e "s#{{ORG}}#${ORG}#g" \
    -e "s#{{AGENTS_ROOT}}#${AGENTS_ROOT}#g" \
    -e "s#{{MEM_ROOT}}#${MEM_ROOT}#g" \
    -e "s#{{BOARD}}#${BOARD:-—}#g" \
    -e "s#{{BUDGET}}#${BUDGET}#g" \
    "$f"
  rm -f "$f.bak"
}

# 1 · control plane
mkdir -p "$control"
cp "$here"/skills/enterprise-brain/templates/{roster,routing,how-we-work,who,environment,memory-model}.md "$control"/
for f in "$control"/*.md; do subst "$f"; done

# 2 · memory tree — never clobbers an existing store (§4.6 adopts on top of one)
mkdir -p "$MEM_ROOT/_shared" "$MEM_ROOT/_unassigned" "$MEM_ROOT/$LIBRARIAN/raw"

if [ -e "$MEM_ROOT/MEMORY.md" ] && [ "${FORCE:-0}" != "1" ]; then
  say "· $MEM_ROOT/MEMORY.md exists — left as-is (nothing overwritten)."
  say "  Add '## Shared' + a section per agent by hand; old flat lines go under '## Unfiled'."
  say "  Shape: skills/enterprise-brain/templates/MEMORY.md · migration: SKILL §4.6"
else
  if [ -e "$MEM_ROOT/MEMORY.md" ]; then
    # NB: not "$f.bak" — subst() runs `sed -i.bak` and then deletes exactly that name.
    backup="$MEM_ROOT/MEMORY.md.$(date +%Y%m%d%H%M%S).orig"
    cp "$MEM_ROOT/MEMORY.md" "$backup"
    say "· FORCE=1 — previous MEMORY.md saved to $backup"
  fi
  cp "$here"/skills/enterprise-brain/templates/MEMORY.md "$MEM_ROOT/MEMORY.md"
  subst "$MEM_ROOT/MEMORY.md"
fi

# create-if-absent; an existing log is an append-only record and is never truncated
[ -f "$MEM_ROOT/$LIBRARIAN/knowledge-log.md" ] || : > "$MEM_ROOT/$LIBRARIAN/knowledge-log.md"

# 3 · optional: install + fill the skills
if [ -n "${INSTALL_SKILLS:-}" ]; then
  sdir="$(expand "$INSTALL_SKILLS")"
  mkdir -p "$sdir"
  cp -R "$here"/skills/enterprise-brain "$sdir"/
  cp -R "$here"/skills/cerebro "$sdir"/
  for f in "$sdir"/enterprise-brain/SKILL.md "$sdir"/cerebro/SKILL.md; do [ -f "$f" ] && subst "$f"; done
  say "✓ skills installed → $sdir  (enterprise-brain, cerebro)"
fi

say ""
say "✓ control plane  → $control   (roster, routing, how-we-work, who, environment, memory-model)"
say "✓ memory tree    → $MEM_ROOT   (_shared/, _unassigned/, $LIBRARIAN/, MEMORY.md)"
say "  _shared/ budget: $BUDGET — full is full, adding means demoting (SKILL §4.5)."
say ""
say "Next:"
say "  1. Open $control/roster.md and add your agents (name · owns · reports-to · identity · namespace)."
say "  2. Add each agent's row to routing.md, and a charter at $AGENTS_ROOT/<agent>.md (SKILL §5.4)."
say "  3. Create each agent's memory folder under $MEM_ROOT/<agent>/ as you onboard it."
say "  4. Adopt the orchestrator-agent-kit for each agent's behaviour."
