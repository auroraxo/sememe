#!/usr/bin/env bash
# Falsification ladder for the lock-pins-nothing refusal.
#
# Each mutation breaks ONE rule of the implementation on purpose. Every
# mutation MUST turn the suite red, and the test that named the rule must be
# the one that fails. A mutation that leaves the suite green proves the rule
# is not actually tested — that is the whole point of running this.
#
#   bash tools/mutation-ladder-lock-nothing-pinned.sh
#
# Rules under test, and the mutation that breaks each:
#   M1  a lock over a store with no receipt is refused  -> drop the writer's
#       empty-store guard
#   M2  a lock that pins no program is refused          -> drop the reader's
#       empty-lock guard
#   M3  the refusal reason is named exactly             -> rename
#       lock-pins-nothing
#   M4  the refusal names the repair                    -> drop the repair
#       sentence from the writer's refusal
#   M5  the empty check runs AFTER the version check   -> run it BEFORE, so
#       a wrong lockVersion is re-labelled lock-pins-nothing
#
# Args are single-quoted on purpose: the target strings contain backticks and
# ${...} template placeholders that a double-quoted shell word would expand.
set -uo pipefail
cd "$(dirname "$0")/.."

TEST="test/lock-nothing-pinned.test.mjs"
BACKUP=$(mktemp -d)
cp src/lock.mjs "$BACKUP/"
restore() { cp "$BACKUP/lock.mjs" src/lock.mjs; }
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

mutation M1 "src/lock.mjs" \
  'if (programs.length === 0) {' \
  'if (false) {' \
  "the writer's empty-store guard (a lock over no receipt must be refused)"

mutation M2 "src/lock.mjs" \
  'if (Object.keys(doc.programs).length === 0) {' \
  'if (false) {' \
  "the reader's empty-lock guard (a lock pinning nothing must be refused)"

mutation M3 "src/lock.mjs" \
  '(lock-pins-nothing)' \
  '(lock-doc-pins-zero)' \
  "the exact refusal reason name (CLI contract)"

mutation M4 "src/lock.mjs" \
  '+ `(lock-pins-nothing) — run "sememe pull <program-id> --store ${storeDir}" first, then lock again`,' \
  '+ `(lock-pins-nothing)`,' \
  "the repair sentence in the writer's refusal (the caller must know what to do)"

mutation M5 "src/lock.mjs" \
  '  if (doc.lockVersion !== LOCK_VERSION) {' \
  '  if (Object.keys(doc.programs ?? {}).length === 0) { throw Error(`pre-version check (lock-pins-nothing)`); }
  if (doc.lockVersion !== LOCK_VERSION) {' \
  "the empty check must run AFTER the lockVersion check, not before it"

restore
if [ "$FAILED" -ne 0 ]; then
  echo "LADDER FAILED: at least one mutation was not caught"
  exit 1
fi
echo "LADDER OK: every mutation was caught"
