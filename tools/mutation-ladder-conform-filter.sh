#!/usr/bin/env bash
# Falsification ladder for the conform filter domain refusal.
#
# Each mutation breaks ONE rule of the implementation on purpose. Every
# mutation MUST turn the suite red, and the test that named the rule must be
# the one that fails. A mutation that leaves the suite green proves the rule
# is not actually tested — that is the whole point of running this.
#
#   bash tools/mutation-ladder-conform-filter.sh
#
# Rules under test, and the mutation that breaks each:
#   M1  a filter that selects nothing is refused        -> drop the eligible.length guard
#   M2  a filter must be a valid program id             -> force isProgramId to true
#   M3  the refusal reason is named exactly             -> rename filter-matched-no-instruction
#   M4  the refusal names the invoked program ids       -> drop the invoked list from the detail
#   M5  a matching filter still runs                    -> never refuse when only is set (M1 variant)
set -uo pipefail
cd "$(dirname "$0")/.."

TEST="test/conformance-filter-domain.test.mjs"
BACKUP=$(mktemp -d)
cp src/conformance.mjs "$BACKUP/"
restore() { cp "$BACKUP/conformance.mjs" src/conformance.mjs; }
trap restore EXIT

FAILED=0

mutation() {
  local name="$1" file="$2" from="$3" to="$4" expect="$5"
  restore
  FROM="$from" TO="$to" FILE="$file" python3 - <<'PY' || { echo "[$name] SKIP: target string not found"; FAILED=1; return; }
import os
path = os.environ['FILE']
old, new = os.environ['FROM'], os.environ['TO']
text = open(path).read()
if old not in text:
    raise SystemExit(2)
open(path, 'w').write(text.replace(old, new, 1))
PY
  local out count fails
  out=$(node --test "$TEST" 2>&1)
  fails=$(echo "$out" | grep -E "^✖" | sed 's/^✖ //' | grep -v "failing tests")
  count=$(echo "$out" | grep -cE "^✖" || true)
  if [ "${count:-0}" -eq 0 ]; then
    echo "[$name] FAILED: suite stayed GREEN under mutation (expected red: $expect)"
    FAILED=1
  else
    echo "[$name] ok — caught by:"
    echo "$fails" | head -5 | sed 's/^/    /'
  fi
}

mutation M1 "src/conformance.mjs" \
  "if (eligible.length === 0) {" \
  "if (false) {" \
  "the eligible.length guard (refusal when nothing is checkable)"

mutation M2 "src/conformance.mjs" \
  "if (!isProgramId(entry)) {" \
  "if (false && !isProgramId(entry)) {" \
  "the isProgramId check (filter must be a program id)"

mutation M3 "src/conformance.mjs" \
  "'filter-matched-no-instruction'," \
  "'filter-matched-nothing-here'," \
  "the exact refusal reason name (CLI contract)"

mutation M4 "src/conformance.mjs" \
  "it invokes: \${invoked.join(', ')}" \
  "it invokes: (omitted by mutation)" \
  "the invoked-program-id detail (caller can see the typo)"

mutation M5 "src/conformance.mjs" \
  "const eligible = instructions.filter((i) => i.programId && (!only || only.includes(i.programId)));" \
  "const eligible = instructions.filter((i) => i.programId);" \
  "the filter actually applies to the eligible set (M5: filter ignored)"

restore
if [ "$FAILED" -ne 0 ]; then
  echo "LADDER FAILED: at least one mutation was not caught"
  exit 1
fi
echo "LADDER PASSED: all 5 mutations caught"
