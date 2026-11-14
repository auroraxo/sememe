#!/usr/bin/env bash
# Falsification ladder for wiring updateSpreadConfig (disc 0x0e) into the
# count-from-header rule on its LIVE witness (14.11. PULS AH).
#
# Each mutation breaks ONE rule of the implementation on purpose. Every
# mutation MUST turn the test file red. A mutation that leaves the ladder
# green proves the rule is not actually tested.
#
#   bash tools/mutation-ladder-hadro-update-spread-config.sh
#
# Rules under test, and the mutation that breaks each:
#   M1  the element size is the MEASURED size of THIS instruction's
#       element type (66 for SpreadTriggerInput), not the global 21 of
#       the curve-point measurement (D2/D3/D4)
#       -> restore a global POINT_BYTES = 21 for every table entry
#   M2  the pair is in the table ONLY because the LIVE artifact witnessed
#       it (D1)
#       -> drop the updateSpreadConfig entry
#   M3  the count comes from the count argument the table NAMES
#       (numTriggers) (D2/D5)
#       -> point the entry at a count argument the IDL does not declare
#   M4  the vector comes from the vector argument the table NAMES
#       (triggers) (D1/D3)
#       -> point the entry at a vector argument the IDL does not declare
#   M5  the table is keyed to the measured PROGRAM ADDRESS (G3)
#       -> key it by instruction name alone, any address
#   M6  the encoder half arms the same rule (D4)
#       -> never arm the hook on the encode side
set -uo pipefail
cd "$(dirname "$0")/.."

TESTS="test/hadro-update-spread-config-count-from-header.test.mjs"
BACKUP=$(mktemp -d)
cp src/codec.mjs src/wire-layout.mjs "$BACKUP/"
restore() {
  cp "$BACKUP/codec.mjs" src/codec.mjs
  cp "$BACKUP/wire-layout.mjs" src/wire-layout.mjs
}
trap restore EXIT

FAILED=0

mutation() {
  local name="$1" file="$2" from="$3" to="$4" expect="$5"
  restore
  FILE="$file" FROM="$from" TO="$to" python3 - <<'PY' || { echo "[$name] SKIP: target string not found"; FAILED=1; return; }
import os
path = os.environ['FILE']
old, new = os.environ['FROM'], os.environ['TO']
text = open(path).read()
if old not in text:
    raise SystemExit(2)
open(path, 'w').write(text.replace(old, new, 1))
PY
  local out count fails
  out=$(node --test "$TESTS" 2>&1)
  count=$(echo "$out" | grep -cE "^✖ " || true)
  if [ "${count:-0}" -eq 0 ]; then
    echo "[$name] FAILED: ladder stayed GREEN under mutation (expected red: $expect)"
    FAILED=1
  else
    fails=$(echo "$out" | grep -E "^✖ " | sed 's/^✖ //' | grep -v "failing tests")
    echo "$name ok — caught by:"
    echo "$fails" | head -5 | sed 's/^/    /'
  fi
}

# M1: a global element size again — the curve measurement's 21 applied to
# the 66-byte triggers. Decode consumes 5x21 and calls the rest trailing.
mutation M1-global-element-size src/wire-layout.mjs \
'updateSpreadConfig: { countArg: '"'"'numTriggers'"'"', vectorArg: '"'"'triggers'"'"', elementBytes: 66,' \
'updateSpreadConfig: { countArg: '"'"'numTriggers'"'"', vectorArg: '"'"'triggers'"'"', elementBytes: 21,' \
'elementBytes is the measured 66, not a global 21 (D2/D3/D4)'

# M2: the entry leaves the table — the strict codec answers with its
# garbage number again.
mutation M2-entry-dropped src/wire-layout.mjs \
'      updateSpreadConfig: { countArg: '"'"'numTriggers'"'"', vectorArg: '"'"'triggers'"'"', elementBytes: 66, source: '"'"'research/live-layout-scan-hadro-witness-2026-11-14.json'"'"' },' \
'' \
'the live witness is what wired this pair (D1)'

# M3: the table names a count argument the IDL does not declare.
mutation M3-count-arg-renamed src/wire-layout.mjs \
'      updateSpreadConfig: { countArg: '"'"'numTriggers'"'"',' \
'      updateSpreadConfig: { countArg: '"'"'numOps'"'"',' \
'count comes from the declared numTriggers (D2/D5)'

# M4: the table names a vector argument the IDL does not declare.
mutation M4-vector-arg-renamed src/wire-layout.mjs \
"vectorArg: 'triggers', elementBytes: 66" \
"vectorArg: 'keys', elementBytes: 66" \
'the armed vector is the declared triggers argument (D1/D3)'

# M5: the table answers for ANY program carrying the instruction name.
mutation M5-table-keyed-by-name-only src/wire-layout.mjs \
'  const entry = COUNT_FROM_HEADER[idl?.address]?.instructions?.[name];' \
'  const entry = Object.values(COUNT_FROM_HEADER).find((program) => program.instructions?.[name])?.instructions?.[name];' \
'program-address gate (G3)'

# M6: the encoder side never arms the hook -> encodeInstructionData writes
# a u32 prefix the wire never carried.
mutation M6-encode-never-armed src/codec.mjs \
'      const headerCount = headerRule
        && argument.name === headerRule.vectorArg
        && '"'"'vec'"'"' in (argument.type ?? {})
        && countIndex !== -1 && vectorIndex !== -1 && countIndex < vectorIndex
        && typeof args[headerRule.countArg] === '"'"'number'"'"' && Number.isSafeInteger(args[headerRule.countArg])
        ? args[headerRule.countArg] : null;' \
'      const headerCount = null;' \
'the encoder half writes no prefix under the rule (D4)'

restore
# CONTROL: the restored tree must be byte-identical and green.
cmp -s "$BACKUP/codec.mjs" src/codec.mjs && cmp -s "$BACKUP/wire-layout.mjs" src/wire-layout.mjs \
  || { echo "CONTROL FAILED: tree differs after restore"; exit 1; }
if ! node --test "$TESTS" 2>&1 | grep -qE "^ℹ fail 0"; then
  echo "CONTROL FAILED: restored tree not green"
  exit 1
fi
echo "control ok — restored tree byte-identical and green"

if [ "$FAILED" -ne 0 ]; then
  echo "MUTATION LADDER FAILED"
  exit 1
fi
echo "MUTATION LADDER PASSED: 6/6 mutations caught"
