#!/usr/bin/env bash
# Falsification ladder for the count-from-header SHAPE scan
# (tools/measure-count-from-header-shape-scan.mjs + its pin
# test/count-from-header-shape-scan.test.mjs).
#
# Each mutation breaks ONE rule of the INSTRUMENT on purpose. Every mutation
# MUST turn the pin file red. A mutation that leaves the ladder green proves
# the face is not actually measured — that is the whole point of running
# this.
#
#   bash tools/mutation-ladder-count-from-header-shape-scan.sh
#
# Rules under test, and the mutation that breaks each:
#   M1  the CAMM flag face is measured from docs text — a tool that always
#       says flagDocumented=false cannot falsify generalization
#       -> hardcode flagDocumented false
#   M2  the CAMM-payload guard must refuse to pin when the world changes
#       -> remove the payloads!==0 guard
#   M3  the setCurve witness face must be re-derived, not trusted
#       -> remove the 72/72 self-check
#   M4  payload counting is deduped per discriminator — a per-candidate
#       count multiplies the witness (5 candidates on setCurve -> 360)
#       -> count per candidate again (the double-count bug from this run,
#          caught by the setCurve self-check)
#   M5  an unwitnessed candidate must NOT be marked in-table by accident
#       -> report inTable from the program key alone (name-insensitive lie)
set -uo pipefail
cd "$(dirname "$0")/.."

TESTS="test/count-from-header-shape-scan.test.mjs"
TOOL="tools/measure-count-from-header-shape-scan.mjs"
BACKUP=$(mktemp -d)
cp "$TOOL" "$BACKUP/"
restore() { cp "$BACKUP/measure-count-from-header-shape-scan.mjs" "$TOOL"; }
trap restore EXIT

FAILED=0

mutation() {
  local name="$1" from="$2" to="$3" expect="$4"
  restore
  FILE="$TOOL" FROM="$from" TO="$to" python3 - <<'PY' || { echo "[$name] SKIP: target string not found"; FAILED=1; return; }
import os
path = os.environ['FILE']
old, new = os.environ['FROM'], os.environ['TO']
text = open(path).read()
if old not in text:
    raise SystemExit(2)
open(path, 'w').write(text.replace(old, new, 1))
PY
  run_ladder "$name" "$expect"
}

# A mutation that must change TWO places at once to break the rule (a single
# change is neutralized by the other — measured: the dedupe lives both in
# byHex and in `discs.find`, so mutating only one keeps every count right).
mutation_two() {
  local name="$1" from1="$2" to1="$3" from2="$4" to2="$5" expect="$6"
  restore
  FILE="$TOOL" FROM1="$from1" TO1="$to1" FROM2="$from2" TO2="$to2" python3 - <<'PY' || { echo "[$name] SKIP: target string not found"; FAILED=1; return; }
import os
path = os.environ['FILE']
pairs = [(os.environ['FROM1'], os.environ['TO1']), (os.environ['FROM2'], os.environ['TO2'])]
text = open(path).read()
for old, new in pairs:
    if old not in text:
        raise SystemExit(2)
    text = text.replace(old, new, 1)
open(path, 'w').write(text)
PY
  run_ladder "$name" "$expect"
}

run_ladder() {
  local name="$1" expect="$2"
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

# M1: flag detection becomes a constant false.
mutation M1-flag-always-false \
'  const flagDocumented = group.some((c) => FLAG_DOC_RE.test(c.docsExcerpt));' \
'  const flagDocumented = false;' \
'D2 flagDocumented is measured from docs'

# M2: drop the CAMM-payload guard.
mutation M2-no-camm-guard \
"  if (camm.payloads !== 0) throw Error('CAMM update_operation_account now carries payloads in the window — the verdict must be re-derived, not pinned');" \
'' \
'G2 exit-3 falsifier (CAMM gaining a payload)'

# M3: drop the setCurve witness self-check.
mutation M3-no-setcurve-selfcheck \
'  if (!setCurve || setCurve.payloads !== 72 || setCurve.accepted !== 72) {' \
'  if (false) {' \
'D3/G2 setCurve 72/72 witness face'

# M4: count payloads PER CANDIDATE (no dedupe at all): both the byHex
# dedupe and the `find` first-match must go, or the count stays 72 and the
# mutation is neutral — measured in this run before both were broken.
mutation_two M4-per-candidate-count \
'  const discs = [...byHex.entries()].map(([hex, c]) => ({ hex, c }));' \
'  const discs = list.filter((c) => Array.isArray(c.discriminator) && c.discriminator.length > 0).map((c) => ({ hex: discToHex(c.discriminator), c }));' \
'      const hit = discs.find(({ hex }) => h.startsWith(hex));
      if (!hit) continue;
      const rec = payloadCounts.get(`${hit.c.program}|${hit.c.instruction}`);
      rec.payloads += 1;
      if (tx.failed === false) rec.accepted += 1; else rec.failed += 1;' \
'      for (const { hex, c } of discs) {
        if (!h.startsWith(hex)) continue;
        const rec = payloadCounts.get(`${c.program}|${c.instruction}`);
        rec.payloads += 1;
        if (tx.failed === false) rec.accepted += 1; else rec.failed += 1;
      }' \
'D3/D1 the witness count is per instruction, deduped'

# M5: inTable keyed by program only (every HADRo shape face lies in-table).
mutation M5-in-table-by-program-only \
'  const tableEntry = COUNT_FROM_HEADER[head.program]?.instructions?.[head.instruction] ?? null;' \
'  const tableEntry = COUNT_FROM_HEADER[head.program] ? (COUNT_FROM_HEADER[head.program].instructions?.[head.instruction] ?? { countArg: head.candidates[0].countArg }) : null;' \
'D4 unwired HADRo faces are NOT in the table'

restore
if [ "$FAILED" -ne 0 ]; then
  echo "MUTATION LADDER FAILED"
  exit 1
fi
echo "MUTATION LADDER PASSED: 5/5 mutations caught"
