#!/usr/bin/env bash
# Falsification ladder for the stored-short-discriminator fix.
#
# Each mutation breaks ONE rule of the implementation on purpose. Every
# mutation MUST turn the ladder red, and the tests that name the rule must be
# among the failures. A mutation that leaves the ladder green proves the rule
# is not actually tested — that is the whole point of running this.
#
#   bash tools/mutation-ladder-hadro-short-discriminator.sh
#
# Rules under test, and the mutation that breaks each:
#   M1  a stored discriminator is stored at ANY length (the defect itself:
#       the old length===8 gate overwrote HADRo's 38 one-byte discriminators)
#       -> require length === 8 again in isStoredDiscriminator
#   M2  the same rule for EVENTS (Eternal stores 76 one-byte event
#       discriminators) — mutate only the event branch
#       -> event branch checks isDiscriminator (8 bytes) instead
#   M3  shank discriminants stay verbatim, never sighashed (v0.4.19 rule)
#       -> overwrite the shank branch value with the Anchor sighash
#   M4  an 8-byte stored-vs-derived conflict is still REPORTED
#       -> drop the conflict push for instructions
#   M5  a genuinely MISSING discriminator is still DERIVED (gap-fill intact)
#       -> fill with a bogus 1-byte value instead of the sighash
#   M6  a conflict never overwrites the stored bytes (report, don't fix)
#       -> apply the derived bytes when a conflict is found
set -uo pipefail
cd "$(dirname "$0")/.."

TEST="test/hadro-short-discriminator.test.mjs"
BACKUP=$(mktemp -d)
cp src/discriminators.mjs "$BACKUP/"
restore() {
  cp "$BACKUP/discriminators.mjs" src/discriminators.mjs
}
trap restore EXIT

FAILED=0

mutation() {
  local name="$1" from="$2" to="$3" expect="$4"
  restore
  FROM="$from" TO="$to" python3 - <<'PY' || { echo "[$name] SKIP: target string not found"; FAILED=1; return; }
import os
path = 'src/discriminators.mjs'
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
    echo "[$name] FAILED: ladder stayed GREEN under mutation (expected red: $expect)"
    FAILED=1
  else
    fails=$(echo "$out" | grep -E "^✖" | sed 's/^✖ //' | grep -v "failing tests")
    echo "[$name] ok — caught by:"
    echo "$fails" | head -5 | sed 's/^/    /'
  fi
}

mutation M1-defect-reverted \
  '  && value.length > 0' \
  '  && value.length === 8' \
  'stored is stored at ANY length (D1-D4)'

mutation M2-event-branch-8-only \
  'if (isStoredDiscriminator(event.discriminator)) {' \
  'if (isDiscriminator(event.discriminator)) {' \
  'event shorts preserved (D2)'

mutation M3-shank-overwritten \
  'instruction.discriminator = [instruction.discriminant.value];' \
  'instruction.discriminator = globalDiscriminator(instruction.name);' \
  'shank rule intact (G2)'

mutation M4-conflict-not-reported \
  "conflicts.push({ kind: 'instruction', name: instruction.name, stored: instruction.discriminator.slice(), derived });" \
  '; // conflict suppressed' \
  '8-byte conflict still reported (G3)'

mutation M5-gap-fill-broken \
  '    instruction.discriminator = globalDiscriminator(instruction.name);' \
  '    instruction.discriminator = [0];' \
  'gap-fill still derives (G1)'

mutation M6-conflict-overwrites-stored \
  "conflicts.push({ kind: 'instruction', name: instruction.name, stored: instruction.discriminator.slice(), derived });" \
  "conflicts.push({ kind: 'instruction', name: instruction.name, stored: instruction.discriminator.slice(), derived }); instruction.discriminator = derived;" \
  'conflict reports but never overwrites (G3)'

restore
if [ "$FAILED" -ne 0 ]; then
  echo "MUTATION LADDER FAILED"
  exit 1
fi
echo "MUTATION LADDER PASSED: 6/6 mutations caught"
