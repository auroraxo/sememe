#!/usr/bin/env bash
# Falsification ladder for the raw-LE dialect engine (src/rawle.mjs).
#
# Each mutation breaks ONE rule of the engine on purpose. Every mutation
# MUST turn the ladder red, and the tests that name the rule must be among
# the failures. A mutation that leaves the ladder green proves the rule is
# not actually tested — that is the whole point of running this.
#
#   bash tools/mutation-ladder-rawle.sh
#
# Rules under test, and the mutation that breaks each:
#   M1  the encoding declaration is REQUIRED (the engine speaks only the
#       dialect the file itself declares) -> drop the encoding check
#   M2  a declared fixed size must equal the field sum (Hop 5 / Base 24)
#       -> skip the size assertion
#   M3  array counters must be PRECEDING fields of the same list
#       -> accept any field name as a counter
#   M4  dispatch is by declared u8 tag only -> accept the first instruction
#   M5  the optional field fires only on an EXACT fit of the remainder
#       -> read the option whenever ANY bytes remain
#   M6  the tag value in args must agree with the instruction tag on encode
#       -> skip the agreement check
#   M7  an array must hold exactly the counter's value on encode
#       -> skip the count equality check
set -uo pipefail
cd "$(dirname "$0")/.."

TEST="test/rawle-decoder.test.mjs test/rawle-decoder-measurement.test.mjs"
BACKUP=$(mktemp -d)
cp src/rawle.mjs "$BACKUP/"
restore() {
  cp "$BACKUP/rawle.mjs" src/rawle.mjs
}
trap restore EXIT

FAILED=0

mutation() {
  local name="$1" from="$2" to="$3"
  restore
  FROM="$from" TO="$to" python3 - <<'PY' || { echo "[$name] SKIP: target string not found"; FAILED=1; return; }
import os
path = 'src/rawle.mjs'
old, new = os.environ['FROM'], os.environ['TO']
text = open(path).read()
if old not in text:
    raise SystemExit(2)
open(path, 'w').write(text.replace(old, new, 1))
PY
  local out count
  out=$(node --test $TEST 2>&1)
  count=$(echo "$out" | grep -cE "^✖" || true)
  if [ "${count:-0}" -eq 0 ]; then
    echo "[$name] FAILED: ladder stayed GREEN under mutation"
    FAILED=1
  else
    fails=$(echo "$out" | grep -E "^✖" | sed 's/^✖ //' | grep -v "failing tests" | head -3)
    echo "[$name] ok — caught by:"
    echo "$fails" | sed 's/^/    /'
  fi
}

mutation M1-encoding-check-dropped \
  "  if (typeof idl.encoding !== 'string' || !/^little-endian\b/.test(idl.encoding)) {
    return 'no little-endian encoding declaration — this engine speaks only the dialect the file itself declares';
  }" \
  '  // M1: encoding declaration no longer required'

mutation M2-size-assertion-skipped \
  "      if (fixed !== type.size) {
        return \`types.\${name}: declared size \${type.size} does not equal the field sum \${fixed}\`;
      }" \
  '      // M2: size assertion skipped'

mutation M3-counter-any-field \
  "  if (!previousNames.has(counter)) {
    return \`\${path}: counter \${JSON.stringify(counter)} is not a preceding field of the same list\`;
  }" \
  '  // M3: counter accepted from anywhere'

mutation M4-first-instruction-dispatch \
  '  const instruction = idl.instructions.find((candidate) => candidate.tag === bytes[0]);' \
  '  const instruction = idl.instructions[0];'

mutation M5-optional-reads-without-bytes \
  '    if (size === null || size !== reader.remaining) return ABSENT;' \
  '    if (size === null) return ABSENT;'

mutation M6-tag-agreement-skipped \
  "      if (tag !== BigInt(instruction.tag)) throw new RawLeError(\`tag value \${value} disagrees with the instruction tag \${instruction.tag}\`, fieldPath);" \
  '      // M6: tag agreement skipped'

mutation M7-array-count-skipped \
  "  if (value.length !== count) {
    throw new RawLeError(\`array of \${value.length} item(s) contradicts counter \${JSON.stringify(resolved.counter)}=\${count}\`, path);
  }" \
  '  // M7: array count equality skipped'

restore
if [ "$FAILED" -ne 0 ]; then
  echo "MUTATION LADDER FAILED"
  exit 1
fi
echo "MUTATION LADDER PASSED: 7/7 mutations caught"
