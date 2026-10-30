#!/usr/bin/env bash
# Falsification ladder for the union decode path.
#
# Each mutation breaks ONE rule of the implementation on purpose. Every mutation
# MUST turn the suite red, and the test that named the rule must be the one that
# fails. A mutation that leaves the suite green proves the rule is not actually
# tested — that is the whole point of running this.
#
#   bash tools/union-mutations.sh
#
# Rules under test, and the mutation that breaks each:
#   M1  two different names for the same bytes is refused  -> skip the refusal
#   M2  a fallback without byte evidence is refused        -> accept it anyway
#   M3a full-round-trip evidence picks the winner          -> always primary
#   M3b fewer-unexplained-bytes evidence picks the winner  -> always primary
#   M4  an adopted copy is not the default source          -> let it win
#   M5  a tampered object is refused in the union path     -> skip the re-hash
set -uo pipefail
cd "$(dirname "$0")/.."

TEST="test/union.test.mjs"
BACKUP=$(mktemp -d)
cp src/union.mjs src/store-read.mjs "$BACKUP/"
restore() { cp "$BACKUP/union.mjs" src/union.mjs; cp "$BACKUP/store-read.mjs" src/store-read.mjs; }
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
    echo "[$name] NOT FALSIFIED — suite stayed green (the rule is untested)"
    FAILED=1
    return
  fi
  if ! echo "$fails" | grep -qi -- "$expect"; then
    echo "[$name] WRONG TEST — wanted a failure matching '$expect', got: $(echo "$fails" | tr '\n' ';')"
    FAILED=1
    return
  fi
  echo "[$name] falsified by: $(echo "$fails" | grep -i -- "$expect" | head -1)"
}

mutation "M1 name conflict refused" src/union.mjs \
  "    throw new UnionRefusal('name_conflict'," \
  "    if (false) throw new UnionRefusal('name_conflict'," \
  "different names for the same bytes"

mutation "M2 fallback needs byte evidence" src/union.mjs \
  "    if (!secProbe.fullExact && !secProbe.describedExact) {" \
  "    if (false) {" \
  "cannot reproduce the bytes"

mutation "M3a full-round-trip arbitration" src/union.mjs \
  "  if (secProbe.fullExact && !primProbe.fullExact) {" \
  "  if (false) {" \
  "explains the WHOLE payload"

mutation "M3b fewer-unexplained-bytes arbitration" src/union.mjs \
  "    && secTrailing < primTrailing) {" \
  "    && false) {" \
  "fewer-unexplained-bytes rule decides"

mutation "M4 adopted copy never becomes default" src/store-read.mjs \
  "  return readVerified(storeDir, program, candidates[candidates.length - 1]);" \
  "  return readVerified(storeDir, program, candidates[0]);" \
  "never becomes the default single source"

mutation "M5 tampered object refused" src/store-read.mjs \
  "  if (actual !== fingerprint) {" \
  "  if (false) {" \
  "tampered stored object is refused"

restore
echo "--- control run (unmutated) ---"
node --test "$TEST" 2>&1 | grep -E "^ℹ (pass|fail)"
exit $FAILED
