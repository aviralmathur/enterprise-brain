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
#
# Roster rows are parsed CR-tolerantly (a CRLF checkout used to blank the last column) and
# an agent's name may contain spaces (it used to be split into two agents).

set -uo pipefail   # deliberately not -e: collect every failure, don't stop at the first

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--example" ]; then
  AGENTS_ROOT="$here/example/agents"
  MEM_ROOT="$here/example/memory"
fi

# -- --selftest ---------------------------------------------------------------------
# Builds a throwaway fleet carrying the two things --example cannot: CRLF line endings,
# and an agent whose display name contains a space. Both defects once shipped, and both
# were invisible here -- the CI runner checks out LF, and every example agent is a single
# word, where deriving the namespace from the name happens to give the right answer.
if [ "${1:-}" = "--selftest" ]; then
  t="$(mktemp -d)" || exit 1
  trap 'rm -rf "$t"' EXIT
  mkdir -p "$t/agents/_control" "$t/memory/_shared" "$t/memory/nick-fury" "$t/memory/athena"

  crlf() { awk '{ printf "%s\r\n", $0 }' > "$1"; }   # write the fixture with CRLF endings

  crlf "$t/agents/_control/roster.md" <<'FIXTURE'
# Roster

| Agent | Owns | Routes through | Identity | Memory namespace |
|---|---|---|---|---|
| **Nick Fury** | the talent lane | -> principal | internal | `nick-fury/` |
| **Athena** | routing | -> principal | internal | `athena/` |
FIXTURE
  crlf "$t/agents/_control/routing.md" <<'FIXTURE'
# Routing

- hiring, panels -> Nick Fury
- anything else -> Athena
FIXTURE
  for f in how-we-work who environment; do crlf "$t/agents/_control/$f.md" <<'FIXTURE'
placeholder
FIXTURE
  done
  crlf "$t/agents/_control/memory-model.md" <<'FIXTURE'
# Memory model

Budget: 20 KB
FIXTURE
  crlf "$t/memory/MEMORY.md" <<'FIXTURE'
# MEMORY
FIXTURE
  crlf "$t/memory/nick-fury/a-note.md" <<'FIXTURE'
---
owner: nick-fury
---
A note owned by an agent whose name has a space in it.
FIXTURE
  crlf "$t/memory/athena/b-note.md" <<'FIXTURE'
---
owner: athena
---
A note.
FIXTURE

  printf 'enterprise-brain \xc2\xb7 validate --selftest\n'
  out="$(AGENTS_ROOT="$t/agents" MEM_ROOT="$t/memory" SKILLS_DIR="" bash "$here/validate.sh" 2>&1)"
  code=$?
  fails=0
  say_ok()   { printf '  \xe2\x9c\x93 %s\n' "$1"; }
  say_fail() { printf '  \xe2\x9c\x97 %s\n' "$1"; fails=1; }

  case "$out" in
    *"2 agents: Nick Fury, Athena"*) say_ok "a two-word agent name parses as one agent" ;;
    *) say_fail "a two-word agent name did not parse as one agent" ;;
  esac
  case "$out" in
    *"'nick fury/'"*|*"'nick/'"*|*"nick-fury does not exist"*)
      say_fail "the namespace was derived from the name, not the last column" ;;
    *) say_ok "the namespace is read from the last column through CRLF endings" ;;
  esac
  case "$out" in
    *"owner: 'nick-fury' is not an agent"*)
      say_fail "a hyphenated owner: did not resolve to its agent" ;;
    *) say_ok "a hyphenated owner: resolves to its agent" ;;
  esac
  if [ "$code" -ne 0 ]; then
    say_fail "the fixture fleet did not validate clean"
    printf '%s\n' "$out" | sed 's/^/      /'
  else
    say_ok "the fixture fleet validates clean"
  fi

  if [ "$fails" -eq 0 ]; then printf '\nselftest passed\n'; exit 0; fi
  printf '\nselftest FAILED\n'; exit 1
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

NL=$'\n'
TAB=$'\t'
CR=$'\r'
# Exact membership in a NEWLINE-delimited set. These sets were once space-padded strings
# tested with *" $x "*, a shape that cannot hold a value containing a space — see §2.
in_set() { case "$NL$2$NL" in *"$NL$1$NL"*) return 0 ;; esac; return 1; }

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
#
# Each agent becomes one TAB-separated record — display name, slug, namespace — in a
# NEWLINE-delimited list. This was once two space-padded strings, which silently split
# every multi-word name in two: "Nick Fury" parsed as the agents `nick` and `fury`, and a
# roster of 16 reported 22. A record per line is the only shape that survives a space in a
# name. The example fleet never caught it because its agents are all single-word — and on
# a single-word roster the namespace fallback below happens to produce the right answer.
hdr "2 · roster"
ROWS=""        # one record per agent: name<TAB>slug<TAB>namespace

if [ -f "$roster" ]; then
  while IFS= read -r line; do
    # A CRLF checkout leaves the \r AFTER the row's closing pipe, so the `${body%|}` below
    # would not strip that pipe, the last column would read back empty on every row, and
    # every namespace would silently fall back to the display name.
    line="${line%$CR}"
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

    # slug: the display name as one token — "Nick Fury" → nick-fury, which is both the
    # conventional folder name and what an owner: line carries.
    slug="$(printf '%s' "$name" | lower | tr ' ' '-')"
    ROWS="$ROWS$name$TAB$slug$TAB$ns$NL"
  done < "$roster"
fi

AGENT_SLUGS="$(printf '%s' "$ROWS" | cut -f2)"
NAMESPACES="$(printf '%s' "$ROWS" | cut -f3)"
n_agents="$(printf '%s' "$ROWS" | grep -c . || true)"
if [ "${n_agents:-0}" -eq 0 ]; then
  warn "no agents parsed from roster.md — is it still all template rows?"
else
  ok "$n_agents $(plural "$n_agents" agent): $(printf '%s' "$ROWS" | cut -f1       | awk 'NR>1{printf ", "}{printf "%s", $0}')"
fi

# ── 3 · every roster row has a routing entry ─────────────────────────────────────────
hdr "3 · roster → routing  (an agent no work can reach)"
if [ ! -f "$routing" ]; then
  err "routing.md missing — cannot check"
else
  routing_l="$(lower < "$routing" | tr -d "$CR")"
  missing=0
  # A roster may spell an agent "Nick Fury" where routing.md says nick-fury, or names only
  # its namespace — any of the three spellings counts as reachable.
  while IFS="$TAB" read -r r_name r_slug r_ns; do
    [ -z "$r_name" ] && continue
    r_lname="$(printf '%s' "$r_name" | lower)"
    case "$routing_l" in
      *"$r_lname"*|*"$r_slug"*|*"$r_ns"*) : ;;
      *) warn "'$r_name' is on the roster but never named in routing.md"; missing=1 ;;
    esac
  done <<EOF
$ROWS
EOF
  [ "$missing" -eq 0 ] && ok "every agent appears in routing.md"
fi

# ── 4 · roster ↔ namespace folders, both directions ──────────────────────────────────
hdr "4 · roster ↔ memory namespaces"
missing=0
while IFS= read -r ns; do
  [ -z "$ns" ] && continue
  if [ ! -d "$MEM_ROOT/$ns" ]; then
    err "roster names namespace '$ns/' but $MEM_ROOT/$ns does not exist"; missing=1
  fi
done <<EOF
$NAMESPACES
EOF
[ "$missing" -eq 0 ] && [ "$n_agents" -gt 0 ] && ok "every roster namespace exists on disk"

orphans=0
for d in "$MEM_ROOT"/*/; do
  [ -d "$d" ] || continue
  b="$(basename "$d")"
  case "$b" in _*|.*) continue ;; esac        # _shared, _unassigned, dotfiles: reserved
  if in_set "$(printf '%s' "$b" | lower)" "$NAMESPACES"; then :
  else warn "'$b/' has notes but no roster row — retired agent, or a row never added?"; orphans=1; fi
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
  # An owner: may name the agent (nick-fury) or its namespace — usually the same token.
  if in_set "$val" "$AGENT_SLUGS" || in_set "$val" "$NAMESPACES"; then :
  else err "owner: '$val' is not an agent or 'shared' → ${file#"$MEM_ROOT"/}"; bad_owner=1; fi
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
  # Exact match: a substring test let [[batman]] resolve against batman-hourly-brief, so a
  # genuinely broken link passed whenever a longer note name happened to contain it.
  if in_set "$link" "$TARGETS"; then :
  else err "broken [[${link}]] → ${file#"$MEM_ROOT"/}"; broken=1; fi
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
