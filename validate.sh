#!/usr/bin/env bash
#
# enterprise-brain · validate
# Check a deployed fleet against itself. Every check here corresponds to a defect that was
# once live in this repo — see KNOWN-ISSUES.md.
#
# Usage:
#   ./validate.sh                                    # uses the defaults below
#   AGENTS_ROOT=~/agents MEM_ROOT=~/.claude/memory ./validate.sh
#   SKILLS_DIR=~/.claude/skills ./validate.sh        # also check installed skills
#   ./validate.sh --example                          # validate this repo's example/ fleet
#
# Exit: 0 if no errors (warnings are allowed), 1 if any error.
#
# What it asserts:
#   1. the control plane is complete
#   2. every roster row has a routing entry            (unroutable agent)
#   3. every roster row has a memory namespace         (roster promises a folder that is absent)
#   4. every namespace folder has a roster row         (retired agent still on disk)
#   5. every `owner:` is a real agent or `shared`      (the _fleet/_shared drift)
#   6. _shared/ is inside its budget, and a budget exists at all
#   7. every [[wikilink]] resolves
#   8. no org-level {{PLACEHOLDER}} survives in an installed skill

set -uo pipefail   # deliberately not -e: collect every failure, don't stop at the first

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--example" ]; then
  AGENTS_ROOT="$here/example/agents"
  MEM_ROOT="$here/example/memory"
fi

expand() { local p="$1"; printf '%s' "${p/#\~/$HOME}"; }
AGENTS_ROOT="$(expand "${AGENTS_ROOT:-$HOME/agents}")"
MEM_ROOT="$(expand "${MEM_ROOT:-$HOME/.claude/memory}")"
SKILLS_DIR="$(expand "${SKILLS_DIR:-}")"
control="$AGENTS_ROOT/_control"

ERRORS=0; WARNS=0
err()  { printf '  ✗ %s\n' "$*"; ERRORS=$((ERRORS+1)); }
warn() { printf '  ! %s\n' "$*"; WARNS=$((WARNS+1)); }
ok()   { printf '  ✓ %s\n' "$*"; }
hdr()  { printf '\n%s\n' "$*"; }

lower()  { tr '[:upper:]' '[:lower:]'; }
plural() { [ "$1" -eq 1 ] && printf '%s' "$2" || printf '%ss' "$2"; }

printf 'enterprise-brain · validate\n'
printf '───────────────────────────\n'
printf 'control plane : %s\n' "$control"
printf 'memory tree   : %s\n' "$MEM_ROOT"
[ -n "$SKILLS_DIR" ] && printf 'skills        : %s\n' "$SKILLS_DIR"

[ -d "$control" ]  || { printf '\n✗ no control plane at %s — run ./init.sh first.\n' "$control"; exit 1; }
[ -d "$MEM_ROOT" ] || { printf '\n✗ no memory tree at %s — run ./init.sh first.\n' "$MEM_ROOT"; exit 1; }

# ── 1 · control plane is complete ────────────────────────────────────────────────────
hdr "1 · control plane"
for f in roster routing how-we-work who environment memory-model; do
  if [ -f "$control/$f.md" ]; then ok "$f.md"
  else err "$f.md missing from $control"; fi
done

roster="$control/roster.md"
routing="$control/routing.md"

# ── 2 · parse the roster ─────────────────────────────────────────────────────────────
# One row per agent: name in column 1, memory namespace in the last column. Rows carrying
# an unfilled {{PLACEHOLDER}} are template scaffolding, not agents — skip them.
hdr "2 · roster"
AGENTS=""      # space-padded set of agent slugs, e.g. " alfred athena scout "
NAMESPACES=""  # matching set of namespace folder names

if [ -f "$roster" ]; then
  while IFS= read -r line; do
    case "$line" in
      *'|'*) : ;;      # only table rows
      *) continue ;;
    esac
    case "$line" in
      *'{{'*) continue ;;                      # template row
      *'---'*) continue ;;                     # separator
    esac

    body="${line#|}"; body="${body%|}"
    name="$(printf '%s' "$body" | awk -F'|' '{print $1}' \
            | sed -e 's/[*`]//g' -e 's/^[[:space:]_]*//' -e 's/[[:space:]_]*$//')"
    last="$(printf '%s' "$body" | awk -F'|' '{print $NF}')"

    [ -z "$name" ] && continue
    case "$(printf '%s' "$name" | lower)" in
      agent|'') continue ;;                    # header row
    esac
    # Illustrative template rows survive substitution (only {{...}} is filled), so an
    # <angle-bracket> placeholder in the name or the namespace still means "not a real agent".
    case "$name$last" in *'<'*'>'*) continue ;; esac

    # namespace: first backticked token in the last column, basename, no trailing slash
    ns="$(printf '%s' "$last" | sed -n 's/.*`\([^`]*\)`.*/\1/p')"
    [ -z "$ns" ] && ns="$name"
    ns="${ns%/}"; ns="${ns##*/}"
    ns="$(printf '%s' "$ns" | lower)"

    slug="$(printf '%s' "$name" | lower)"
    AGENTS="$AGENTS$slug "
    NAMESPACES="$NAMESPACES$ns "
  done < "$roster"
fi

AGENTS=" $AGENTS"; NAMESPACES=" $NAMESPACES"
n_agents="$(printf '%s' "$AGENTS" | wc -w | tr -d ' ')"
if [ "$n_agents" -eq 0 ]; then
  warn "no agents parsed from roster.md — is it still all template rows?"
else
  ok "$n_agents $(plural "$n_agents" agent): $(printf '%s' "$AGENTS" | sed 's/^ *//;s/ *$//')"
fi

# ── 3 · every roster row has a routing entry ─────────────────────────────────────────
hdr "3 · roster → routing  (an agent no work can reach)"
if [ ! -f "$routing" ]; then
  err "routing.md missing — cannot check"
else
  routing_l="$(lower < "$routing")"
  missing=0
  for a in $AGENTS; do
    case "$routing_l" in
      *"$a"*) : ;;
      *) warn "'$a' is on the roster but never named in routing.md"; missing=1 ;;
    esac
  done
  [ "$missing" -eq 0 ] && ok "every agent appears in routing.md"
fi

# ── 4 · roster ↔ namespace folders, both directions ──────────────────────────────────
hdr "4 · roster ↔ memory namespaces"
set -- $NAMESPACES
missing=0
for ns in "$@"; do
  if [ ! -d "$MEM_ROOT/$ns" ]; then
    err "roster names namespace '$ns/' but $MEM_ROOT/$ns does not exist"; missing=1
  fi
done
[ "$missing" -eq 0 ] && [ "$n_agents" -gt 0 ] && ok "every roster namespace exists on disk"

orphans=0
for d in "$MEM_ROOT"/*/; do
  [ -d "$d" ] || continue
  b="$(basename "$d")"
  case "$b" in _*|.*) continue ;; esac        # _shared, _unassigned, dotfiles: reserved
  case "$NAMESPACES" in
    *" $(printf '%s' "$b" | lower) "*) : ;;
    *) warn "'$b/' has notes but no roster row — retired agent, or a row never added?"; orphans=1 ;;
  esac
done
[ "$orphans" -eq 0 ] && ok "no orphaned namespace folders"

# ── 5 · owner: values ────────────────────────────────────────────────────────────────
# The _fleet/_shared drift: an owner: nothing loads, in a file that looks filed.
hdr "5 · owner: values"
bad_owner=0; n_owned=0
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  file="${hit%%:*}"
  val="$(printf '%s' "${hit#*:}" | sed -e 's/^[[:space:]]*owner:[[:space:]]*//' \
         -e 's/#.*//' -e 's/[[:space:]]*$//' | lower)"
  [ -z "$val" ] && continue
  n_owned=$((n_owned+1))
  case "$val" in
    shared) continue ;;
    *'<'*|*'|'*) continue ;;                   # template placeholder, e.g. <agent> | shared
  esac
  case "$AGENTS" in
    *" $val "*) : ;;
    *) err "owner: '$val' is not an agent or 'shared' → ${file#"$MEM_ROOT"/}"; bad_owner=1 ;;
  esac
done <<EOF
$(grep -rn '^owner:' --include=*.md "$MEM_ROOT" 2>/dev/null | sed 's/:[0-9]*:/:/')
EOF
# notes only: not the index, not the librarian's append-only log, not its raw source inbox
n_notes="$(find "$MEM_ROOT" -name '*.md' -type f ! -name 'MEMORY.md' ! -name 'knowledge-log.md' \
           2>/dev/null | grep -v '/raw/' | wc -l | tr -d ' ')"
if [ "$n_notes" -eq 0 ]; then ok "no notes filed yet — nothing to own"
elif [ "$n_owned" -eq 0 ]; then warn "$n_notes notes but not one owner: — the ownership contract is not being applied"
elif [ "$bad_owner" -eq 0 ]; then ok "$n_owned/$n_notes notes carry an owner:, all resolve"
fi

# ── 6 · the _shared/ budget ──────────────────────────────────────────────────────────
hdr "6 · _shared/ budget"
budget_line="$(grep -h -m1 -o 'Budget:[[:space:]]*[0-9]\+[[:space:]]*[A-Za-z]*' \
  "$control/memory-model.md" "$MEM_ROOT/MEMORY.md" 2>/dev/null | head -1)"
if [ -z "$budget_line" ]; then
  warn "no budget recorded in memory-model.md or MEMORY.md — a cap you cannot point at is not a cap"
else
  num="$(printf '%s' "$budget_line" | grep -o '[0-9]\+' | head -1)"
  unit="$(printf '%s' "$budget_line" | sed 's/.*[0-9][[:space:]]*//' | lower)"
  case "$unit" in
    line*)
      used="$(awk '/^## Shared/{f=1;next} /^## /{f=0} f&&NF' "$MEM_ROOT/MEMORY.md" 2>/dev/null | wc -l | tr -d ' ')"
      cap="$num"; label="lines in ## Shared" ;;
    mb) cap=$((num*1024*1024)); label="bytes" ;;
    b)  cap="$num"; label="bytes" ;;
    *)  cap=$((num*1024)); label="bytes" ;;     # KB default
  esac
  case "$unit" in
    line*) : ;;   # already counted above
    *) used="$(find "$MEM_ROOT/_shared" -type f -name '*.md' -exec cat {} + 2>/dev/null \
               | wc -c | tr -d ' ')" ;;
  esac
  if [ "${used:-0}" -gt "$cap" ]; then
    err "_shared/ is over budget: $used / $cap $label — demote something to an agent namespace"
  else
    ok "_shared/ within budget: ${used:-0} / $cap $label"
  fi
fi

# ── 7 · wikilinks resolve ────────────────────────────────────────────────────────────
hdr "7 · [[wikilinks]]"
# A link resolves if some note's filename, frontmatter name:, or aliases: matches it.
TARGETS="$( { find "$MEM_ROOT" -name '*.md' -type f 2>/dev/null \
                | sed -e 's#.*/##' -e 's/\.md$//'
              grep -rh '^name:' --include=*.md "$MEM_ROOT" 2>/dev/null \
                | sed 's/^name:[[:space:]]*//'
              grep -rh '^aliases:' --include=*.md "$MEM_ROOT" 2>/dev/null \
                | sed -e 's/^aliases:[[:space:]]*//' -e 's/[][]//g' -e 's/,/\n/g'
            } | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | lower | sort -u )"

broken=0; n_links=0
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  file="${hit%%:*}"
  link="$(printf '%s' "${hit#*:}" | sed -e 's/^\[\[//' -e 's/\]\]$//' \
          -e 's/|.*//' -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | lower)"
  [ -z "$link" ] && continue
  n_links=$((n_links+1))
  case "$TARGETS" in
    *"$link"*) : ;;
    *) err "broken [[${link}]] → ${file#"$MEM_ROOT"/}"; broken=1 ;;
  esac
done <<EOF
$(grep -ro '\[\[[^]]*\]\]' --include=*.md "$MEM_ROOT" 2>/dev/null)
EOF
if [ "$n_links" -eq 0 ]; then ok "no wikilinks to check"
elif [ "$broken" -eq 0 ]; then ok "$n_links wikilinks, all resolve"; fi

# ── 8 · placeholders in installed skills ─────────────────────────────────────────────
# templates/ keeps its placeholders on purpose (they are filled per-agent at onboarding),
# and the skill README documents them. Anywhere else, an unfilled org-level placeholder
# means the install never got substituted.
if [ -n "$SKILLS_DIR" ] && [ -d "$SKILLS_DIR" ]; then
  hdr "8 · installed skills"
  left=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in */templates/*|*/README.md) continue ;; esac
    err "unfilled placeholder in ${f#"$SKILLS_DIR"/}: $(grep -o '{{[A-Z_]*}}' "$f" | sort -u | tr '\n' ' ')"
    left=1
  done <<EOF
$(grep -rl '{{BRAIN}}\|{{PRINCIPAL}}\|{{ORG}}\|{{MEM_ROOT}}\|{{AGENTS_ROOT}}\|{{BUDGET}}\|{{BOARD}}' \
    --include=*.md "$SKILLS_DIR" 2>/dev/null)
EOF
  [ "$left" -eq 0 ] && ok "no unfilled org-level placeholders"
fi

# ── summary ──────────────────────────────────────────────────────────────────────────
printf '\n───────────────────────────\n'
if [ "$ERRORS" -eq 0 ] && [ "$WARNS" -eq 0 ]; then
  printf '✓ clean — %s %s, control plane current.\n' "$n_agents" "$(plural "$n_agents" agent)"
else
  printf '%s error(s), %s warning(s).\n' "$ERRORS" "$WARNS"
  [ "$ERRORS" -gt 0 ] && printf 'Errors are things that are broken now. Warnings are things that rot.\n'
fi
exit $([ "$ERRORS" -eq 0 ] && echo 0 || echo 1)
