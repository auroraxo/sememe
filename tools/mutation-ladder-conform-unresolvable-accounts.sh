#!/usr/bin/env bash
# Falsification ladder for the unresolvable-account-index refusal.
#
# Each mutation breaks ONE rule of the implementation on purpose. Every
# mutation MUST turn the suite red, and the test that named the rule must be
# the one that fails. A mutation that leaves the suite green proves the rule
# is not actually tested — that is the whole point of running this.
#
#   bash tools/mutation-ladder-conform-unresolvable-accounts.sh
#
# Rules under test, and the mutation that breaks each:
#   M1  an unresolvable account index is REFUSED, not folded into a null row
#       -> drop the collection of unresolved accounts (the defect itself)
#   M2  the refusal reason is named exactly (CLI contract)
#       -> rename instruction-account-index-unresolvable
#   M3  the detail names the offending instruction, the account position and
#       the raw value
#       -> strip the described list from the detail
#   M4  the refusal covers CPI instructions too
#       -> skip depth > 0 instructions in the check
#   M5  a NON-INTEGER account entry (the jsonParsed object shape) is refused
#       -> accept any index that is a number, however non-integer
#   M6  the refusal fires BEFORE the store is read / the filter selection
#       -> move the account check behind the eligibility computation
set -uo pipefail
cd "$(dirname "$0")/.."

TEST="test/conform-unresolvable-accounts.test.mjs"
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
  count=$(echo "$out" | grep -cE "^✖" || true)
  if [ "${count:-0}" -eq 0 ]; then
    echo "[$name] FAILED: suite stayed GREEN under mutation (expected red: $expect)"
    FAILED=1
  else
    fails=$(echo "$out" | grep -E "^✖" | sed 's/^✖ //' | grep -v "failing tests")
    echo "[$name] ok — caught by:"
    echo "$fails" | head -4 | sed 's/^/    /'
  fi
}

# M1: the defect itself — a null row instead of a refusal.
mutation M1 "src/conformance.mjs" \
  "      if (!Number.isSafeInteger(index) || index < 0 || index >= keys.length) {
        unresolvedAccounts.push({ position: positionInInstruction, value: index });
        return { address: null, signer: null, writable: null };
      }" \
  "      if (!Number.isSafeInteger(index) || index < 0 || index >= keys.length) {
        return { address: null, signer: null, writable: null };
      }" \
  "the unresolvable-account refusal itself (A1/A2/A3/A4/A6 go green)"

# M2: the exact refusal reason name (the CLI contract).
mutation M2 "src/conformance.mjs" \
  "'instruction-account-index-unresolvable'," \
  "'instruction-account-broken'," \
  "the exact refusal reason name"

# M3: the detail names the offending instruction, position and raw value.
# The target must be the ACCOUNT refusal's OWN detail: the looser string
# "${described}) - the gate" matches the program-id refusal FIRST (replace
# count 1) and mutates the wrong block — measured on the first ladder run,
# where M3 was vacuous and the suite stayed green.
mutation M3 "src/conformance.mjs" \
  'resolve inside message.accountKeys + meta.loadedAddresses (${described}) ' \
  'resolve inside message.accountKeys + meta.loadedAddresses () ' \
  "positions and raw values in the detail (A5 goes green)"

# M4: CPI instructions are covered too.
mutation M4 "src/conformance.mjs" \
  ".filter(({ instruction }) => instruction.unresolvedAccounts.length > 0);" \
  ".filter(({ instruction }) => instruction.unresolvedAccounts.length > 0 && !instruction.depth);" \
  "CPI instructions are covered too (A3 goes green)"

# M5: a NON-INTEGER account entry (the jsonParsed object shape) is refused
# -> drop the integer check: an object entry resolves to NaN via index
# arithmetic, and NaN < 0 / NaN >= keys.length are both FALSE, so it falls
# through to a resolved row and A4's refusal never fires.
mutation M5 "src/conformance.mjs" \
  "if (!Number.isSafeInteger(index) || index < 0 || index >= keys.length) {" \
  "if (index < 0 || index >= keys.length) {" \
  "a non-integer account entry is refused (A4 goes green)"

# M6: the refusal fires on the UNFILTERED path too — conditioning it on
# `only` makes the broken shape report rows whenever no filter is given.
mutation M6 "src/conformance.mjs" \
  "if (unresolvableAccounts.length) {" \
  "if (unresolvableAccounts.length && only) {" \
  "the refusal covers the unfiltered path too (A1/A2/A6 go green without --only)"

restore
if [ "$FAILED" -ne 0 ]; then
  echo "LADDER FAILED: at least one mutation was not caught"
  exit 1
fi
echo "LADDER PASSED: all 6 mutations caught"
