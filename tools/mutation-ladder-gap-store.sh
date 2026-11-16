#!/usr/bin/env bash
# Falsification ladder for the store-aware `sememe gap` rules
# (the defect measured 2026-11-16: a store-blind gap told a stranger to redo
# both acquisitions it had already run, and printed an unmeasured payloads 0).
#
# Each mutation breaks ONE rule of the implementation on purpose. Every
# mutation MUST turn the ladder red, and the test that named the rule must be
# the one that fails. A mutation that leaves the ladder green proves the rule
# is not actually tested — that is the whole point of running this.
#
#   bash tools/mutation-ladder-gap-store.sh
#
# Rules under test, and the mutation that breaks each:
#   M1  a store that HOLDS the program changes the verdict -> never fold
#   M2  the chain fact survives as chainVerdict           -> drop it
#   M3  an RPC failure stays unknown even when held       -> let the store
#       mask the failure
#   M4  a store the reader refuses is NOT an absence      -> swallow the
#       refusal as not-held
#   M5  a missing store is an ANSWER, not an error        -> rethrow
#   M6  a held program is told to DECODE, not to acquire  -> advice falls
#       through to the chain verdict (pull / adopt-lighthouse again)
#   M7  the CLI prints no payload count it never measured -> put payloads 0
#       back into the CLI probe
#
# Args are single-quoted on purpose: the target strings contain ${...}
# template placeholders that a double-quoted shell word would expand.
set -uo pipefail
cd "$(dirname "$0")/.."

TEST="test/gap-store.test.mjs"
BACKUP=$(mktemp -d)
cp src/gap.mjs bin/sememe.mjs "$BACKUP/"
restore() { cp "$BACKUP/gap.mjs" src/gap.mjs; cp "$BACKUP/sememe.mjs" bin/sememe.mjs; }
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
    echo "[$name] FAILED: ladder stayed GREEN under mutation (expected red: $expect)"
    FAILED=1
  else
    echo "[$name] ok — caught by:"
    echo "$fails" | head -5 | sed 's/^/    /'
  fi
}

mutation M1 "src/gap.mjs" \
  'if (store.state !== '"'"'held'"'"' || row.verdict === '"'"'unknown'"'"') return merged;' \
  'if (true) return merged;' \
  "the store fold (a held program must become verdict stored)"

mutation M2 "src/gap.mjs" \
  'merged.chainVerdict = row.verdict;' \
  'merged.chainVerdict = undefined;' \
  "chainVerdict preservation (a stored row must keep the fact it was built on)"

mutation M3 "src/gap.mjs" \
  'if (store.state !== '"'"'held'"'"' || row.verdict === '"'"'unknown'"'"') return merged;' \
  'if (store.state !== '"'"'held'"'"') return merged;' \
  "the RPC-failure precedence (unknown must survive even when the store holds)"

mutation M4 "src/gap.mjs" \
  '    throw error;
  }
  const receipts' \
  '    return { state: '"'"'not-held'"'"', dir: storeDir };
  }
  const receipts' \
  "the refusal of a damaged store (damage must never read as not-held)"

mutation M5 "src/gap.mjs" \
  "if (error?.code === 'no-sememe-store') return { state: 'no-store', dir: storeDir };" \
  "if (error?.code === 'no-sememe-store') throw error;" \
  "the missing store as an ANSWER (no-store must not fail the probe)"

mutation M6 "src/gap.mjs" \
  "if (row.verdict === 'stored' && store?.state === 'held') {" \
  "if (false) {" \
  "the acquisition-free advice (a held program must never be told to pull/adopt again)"

mutation M7 "bin/sememe.mjs" \
  'const { rows } = await probe([{ program }], { url: rpc, storeDir: store });' \
  'const { rows } = await probe([{ program, payloads: 0 }], { url: rpc, storeDir: store });' \
  "the CLI payload field (no count the CLI never measured)"

restore
if [ "$FAILED" -ne 0 ]; then
  echo "LADDER FAILED: at least one mutation was not caught"
  exit 1
fi
echo "LADDER OK: every mutation was caught"
