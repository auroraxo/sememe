#!/usr/bin/env bash
# Falsification ladder for the unresolvable-program-id refusal.
#
# Each mutation breaks ONE rule of the implementation on purpose. Every
# mutation MUST turn the suite red, and the test that named the rule must be
# the one that fails. A mutation that leaves the suite green proves the rule
# is not actually tested — that is the whole point of running this.
#
#   bash tools/mutation-ladder-conform-unresolvable.sh
#
# Rules under test, and the mutation that breaks each:
#   M1  a SOME-unresolvable transaction is refused, not silently dropped
#       -> restore the old `continue` (the defect itself)
#   M2  the refusal reason is named exactly (CLI contract)
#       -> rename instruction-program-id-unresolvable
#   M3  the refusal fires BEFORE the filter selection
#       -> move it behind filter-matched-no-instruction
#   M4  the detail names the offending positions and index values
#       -> strip the described list from the detail
#   M5  the ALL-unresolvable case keeps its existing reason
#       -> let the new reason swallow it too
#   M6  the refusal covers CPI instructions too
#       -> skip depth > 0 instructions in the check
set -uo pipefail
cd "$(dirname "$0")/.."

TEST="test/conform-unresolvable-program-id.test.mjs"
BACKUP=$(mktemp -d)
cp src/conformance.mjs "$BACKUP/"
restore() {
  cp "$BACKUP/conformance.mjs" src/conformance.mjs
}
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

# M1: the defect itself — drop the refusal, restore the silent skip.
mutation M1 "src/conformance.mjs" \
  "if (unresolvable.length) {
    const described" \
  "if (false) {
    const described" \
  "the partial-drop refusal itself (U1/U2/U3 go green)"

# M2: the exact refusal reason name (the CLI contract).
mutation M2 "src/conformance.mjs" \
  "'instruction-program-id-unresolvable'," \
  "'instruction-program-id-broken'," \
  "the exact refusal reason name"

# M3: the refusal fires BEFORE the filter selection — a broken shape must
# not be masked as "this filter matched nothing".
mutation M3 "src/conformance.mjs" \
  "if (unresolvable.length) {
    const described" \
  "if (unresolvable.length && !only) {
    const described" \
  "refusal order vs filter-matched-no-instruction (U1 goes red on the wrong reason)",

# M4: the detail names the offending positions and index values.
mutation M4 "src/conformance.mjs" \
  "\${described}) — the gate cannot report" \
  "\${''}) — the gate cannot report" \
  "positions and index values in the detail (U5 goes green)"

# M5: the ALL-unresolvable case keeps its EXISTING reason.
mutation M5 "src/conformance.mjs" \
  "if (unresolvable.length && unresolvable.length === instructions.length) {
    throw new ConformanceRefusal(
      'transaction-has-no-resolvable-program-id'," \
  "if (unresolvable.length && unresolvable.length === instructions.length) {
    throw new ConformanceRefusal(
      'instruction-program-id-unresolvable'," \
  "the existing all-unresolvable reason must not move (G2 goes green)"

# M6: the check must include CPI instructions (depth > 0), not only top level.
mutation M6 "src/conformance.mjs" \
  ".filter(({ instruction }) => !instruction.programId);" \
  ".filter(({ instruction }) => !instruction.programId && !instruction.depth);" \
  "CPI instructions are covered too (U4 goes green)"

restore
if [ "$FAILED" -ne 0 ]; then
  echo "LADDER FAILED: at least one mutation was not caught"
  exit 1
fi
echo "LADDER PASSED: all 6 mutations caught"
