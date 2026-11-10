#!/usr/bin/env bash
# Falsification ladder for the conform store-damage refusal.
#
# Each mutation breaks ONE rule of the implementation on purpose. Every
# mutation MUST turn the suite red, and the test that named the rule must be
# the one that fails. A mutation that leaves the suite green proves the rule
# is not actually tested — that is the whole point of running this.
#
#   bash tools/mutation-ladder-conform-store-damage.sh
#
# Rules under test, and the mutation that breaks each:
#   M1  a reader refusal is not swallowed into idl=null  -> restore the catch-all
#   M2  a missing store is refused                       -> treat no-sememe-store as absence
#   M3  the refusal reason is named exactly              -> rename store-reader-refused
#   M4  the refusal carries the program id               -> drop the program id prefix
#   M5  a genuine absence is still an honest gap         -> refuse no-stored-idl too
set -uo pipefail
cd "$(dirname "$0")/.."

TEST="test/conform-store-damage.test.mjs"
BACKUP=$(mktemp -d)
cp src/conformance.mjs "$BACKUP/"
cp src/store-read.mjs "$BACKUP/"
restore() {
  cp "$BACKUP/conformance.mjs" src/conformance.mjs
  cp "$BACKUP/store-read.mjs" src/store-read.mjs
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

mutation M1 "src/conformance.mjs" \
  "if (code !== 'no-stored-idl') {" \
  "if (false) {" \
  "the refusal guard (M1: swallow every refusal like before)"

mutation M2 "src/conformance.mjs" \
  "const reason = code === 'no-sememe-store' ? 'no-sememe-store' : 'store-reader-refused';" \
  "if (code === 'no-sememe-store') { idl = null; idlCache.set(instruction.programId, idl); continue; } const reason = 'store-reader-refused';" \
  "missing store must be refused (M2: missing store treated as empty)"

mutation M3 "src/conformance.mjs" \
  "? 'no-sememe-store' : 'store-reader-refused';" \
  "? 'no-sememe-store' : 'store-reader-broken';" \
  "the exact refusal reason name (CLI contract)"

mutation M4 "src/conformance.mjs" \
  "\`\${instruction.programId}: \${String(error?.message ?? error)} — \`" \
  "\`\${String(error?.message ?? error)} — \`" \
  "the program id in the refusal detail (caller knows which program)"

mutation M5 "src/conformance.mjs" \
  "if (code !== 'no-stored-idl') {" \
  "if (true) {" \
  "an honest acquisition gap must NOT be refused (C4 becomes refusal)"

restore
if [ "$FAILED" -ne 0 ]; then
  echo "LADDER FAILED: at least one mutation was not caught"
  exit 1
fi
echo "LADDER PASSED: all 5 mutations caught"
