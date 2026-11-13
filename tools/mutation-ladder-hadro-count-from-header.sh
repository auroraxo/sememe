#!/usr/bin/env bash
# Falsification ladder for the HADRo count-from-header fix
# (src/wire-layout.mjs + the codec hooks in src/codec.mjs).
#
# Each mutation breaks ONE rule of the implementation on purpose. Every
# mutation MUST turn the test file red. A mutation that leaves the ladder
# green proves the rule is not actually tested — that is the whole point of
# running this.
#
#   bash tools/mutation-ladder-hadro-count-from-header.sh
#
# Rules under test, and the mutation that breaks each:
#   M1  decode arming: the hook fires only when the count argument was
#       declared AND decoded before the vector (D1/D3/D5)
#       -> never arm the hook on the decode side
#   M2  the count is the DECODED header argument's value, not a byte the
#       codec guesses at (D2/D3/D5)
#       -> read the count from the byte in front of the points instead
#   M3  the encoder half writes NO u32 prefix (D4/G2)
#       -> write the prefix anyway under the rule
#   M4  a count that does not fit is refused BY NAME — the layout rule is
#       spoken, never a garbage number (D6)
#       -> drop the named voice from the refusal
#   M5  the table is keyed to the measured PROGRAM ADDRESS (G4)
#       -> key it by instruction name alone, any address
#   M6  an encode whose elements disagree with the declared count is
#       refused, not silently corrected (G2)
#       -> trust the element length instead of the header count
set -uo pipefail
cd "$(dirname "$0")/.."

TESTS="test/hadro-count-from-header.test.mjs"
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

# M1: decode side never arms the hook -> the strict prefix codec answers.
mutation M1-decode-never-armed src/codec.mjs \
'      && typeof args[headerRule.countArg] === '"'"'number'"'"' && Number.isSafeInteger(args[headerRule.countArg])
      ? args[headerRule.countArg] : null;' \
'      && typeof args[headerRule.countArg] === '"'"'number'"'"' && Number.isSafeInteger(args[headerRule.countArg])
      ? null;' \
'decode hook armed (D1/D3/D5)'

# M2: the count is a guessed byte, not the decoded header argument.
mutation M2-count-guessed src/codec.mjs \
'      && typeof args[headerRule.countArg] === '"'"'number'"'"' && Number.isSafeInteger(args[headerRule.countArg])
      ? args[headerRule.countArg] : null;' \
'      ? cursor.bytes[cursor.offset - 1] : null;' \
'count is the decoded numPoints value (D2/D3/D5)'

# M3: the encoder half writes the Borsh prefix anyway.
mutation M3-encoder-writes-prefix src/codec.mjs \
'      const parts = [];
      value.forEach((item, index) =>
        parts.push(encodeAt(type.vec, item, ctx, `${path}[${index}]`, depth + 1)));
      return Buffer.concat(parts);' \
'      const parts = [writeLittle(4, false, value.length, path)];
      value.forEach((item, index) =>
        parts.push(encodeAt(type.vec, item, ctx, `${path}[${index}]`, depth + 1)));
      return Buffer.concat(parts);' \
'encoder writes no prefix (D4/G2)'

# M4: the refusal loses its named voice (back to an unnamed length error).
mutation M4-refusal-unnamed src/codec.mjs \
'`${length} ${elementSize}-byte element(s) need ${needed} byte(s) but ${cur.remaining} remain — ` +
          `${ctx.__countFromHeader.instruction}.${ctx.__countFromHeader.vectorArg} has no length prefix on the wire; ` +
          `the count comes from ${ctx.__countFromHeader.countArg}`' \
'`${length} ${elementSize}-byte element(s) need ${needed} byte(s) but ${cur.remaining} remain`' \
'named refusal voice (D6)'

# M5: the table answers for ANY program carrying the instruction name.
mutation M5-table-keyed-by-name-only src/wire-layout.mjs \
'  const entry = COUNT_FROM_HEADER[idl?.address]?.instructions?.[name];' \
'  const entry = Object.values(COUNT_FROM_HEADER).find((program) => program.instructions?.[name])?.instructions?.[name];' \
'program-address gate (G4)'

# M6: an encode whose elements disagree with the header count is trusted.
mutation M6-encode-mismatch-trusted src/codec.mjs \
'      if (value.length !== count) {
        throw new CodecError(
          `${instruction}.${vectorArg} carries ${value.length} element(s) but ${countArg} says ${count} — ` +
          `this vector has no length prefix on the wire, the count is the header`, path);
      }' \
'      if (false) {
        throw new CodecError(`unreachable`, path);
      }' \
'encode mismatch refused (G2)'

restore
if [ "$FAILED" -ne 0 ]; then
  echo "MUTATION LADDER FAILED"
  exit 1
fi
echo "MUTATION LADDER PASSED: 6/6 mutations caught"
