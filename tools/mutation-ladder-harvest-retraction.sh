#!/usr/bin/env bash
# tools/mutation-ladder-harvest-retraction.sh — the retraction pin must FAIL
# when the reader's half of the mailbox contract is broken. A pin that cannot
# go red is decoration.
#
# The contract under mutation (see test/harvest-reeflog-retraction.test.mjs):
# a row reeflog marked `seal: "reverted"` must never become a payload source,
# must be NAMED rather than dropped, and every other seal must still harvest.
#
#   M1 drop the seal check entirely            -> D1/D2 red
#   M2 test the wrong seal value               -> D1 red
#   M3 the retracted row is not named          -> D1 red
#   M4 retraction counters are not always      -> C1 red
#      present (empty list becomes absent)
#   M5 a missing/null seal counts as a revert  -> G1 red
#   M6 every seal but 'finalized' is dropped   -> G2 red
#   M7 the all-retracted refusal is softened   -> D3 red
#      (exit 0 + a document)
#   M8 the retracted row lands in the envelope -> D2 red
#      debt bucket instead of its own
#   CONTROL no mutation                        -> green
#
# Usage: bash tools/mutation-ladder-harvest-retraction.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

TOOL="tools/harvest-reeflog.mjs"
PIN="test/harvest-reeflog-retraction.test.mjs"
WORK="$(mktemp -d /tmp/sememe-harvest-retract-ladder-XXXXXX)"
CAUGHT=0
TOTAL=0
FAILED=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

snapshot() {
  find "$TOOL" "$PIN" -type f -print0 | sort -z | xargs -0 sha256sum
}

control_before="$(snapshot)"

run_pin() {
  node --test "$PIN" >/dev/null 2>&1
}

mutate() { # mutate <perl-expr>
  perl -0pi -e "$1" "$TOOL" || return 1
}

restore() {
  cp "$WORK/tool.orig" "$TOOL"
}

check() { # check <id>
  local id="$1"
  TOTAL=$((TOTAL + 1))
  if run_pin; then
    echo "VACUUM  $id — pin stayed GREEN under mutation"
    FAILED=$((FAILED + 1))
    restore
  else
    echo "CAUGHT  $id"
    CAUGHT=$((CAUGHT + 1))
    restore
  fi
}

cp "$TOOL" "$WORK/tool.orig"

if ! run_pin; then
  echo "CONTROL FAILED — pin is red before any mutation; refusing to measure"
  exit 2
fi
echo "CONTROL green"

# M1: the seal check never fires.
mutate "s/if \(row\.seal === 'reverted'\) \{/if (false) {/" && check "M1-no-seal-check"

# M2: the check looks for a value reeflog never prints.
mutate "s/if \(row\.seal === 'reverted'\) \{/if (row.seal === 'reverted-not-a-value') {/" && check "M2-wrong-seal-value"

# M3: the row is dropped instead of named.
mutate "s/    rowsReverted\+\+;\n    if \(row\.signature\) revertedSignatures\.push\(row\.signature\);/    rowsReverted++;/" && check "M3-retracted-not-named"

# M4: the counters vanish when there is nothing to report.
mutate "s/    rowsReverted,\n    revertedSignatures,/    ...(rowsReverted > 0 ? { rowsReverted, revertedSignatures } : {}),/" && check "M4-counters-conditional"

# M5: a row that says nothing about its seal is treated as retracted — the
# lie in the other direction (a reader inventing a revert).
mutate "s/if \(row\.seal === 'reverted'\) \{/if (row.seal === 'reverted' || row.seal === undefined || row.seal === null) {/" && check "M5-missing-seal-is-revert"

# M6: the fix over-corrects and drops every row that is not finalized yet.
mutate "s/if \(row\.seal === 'reverted'\) \{/if (row.seal === 'reverted' || (row.seal !== undefined \&\& row.seal !== null \&\& row.seal !== 'finalized')) {/" && check "M6-non-final-dropped"

# M7: a journal of only retracted rows reports success.
mutate "s/    process\.exit\(1\);\n  \}\n  console\.error\('no enriched rows/    process.exit(0);\n  }\n  console.error('no enriched rows/" && check "M7-all-retracted-success"

# M8: the retraction lands in the envelope-debt bucket (before the seal gate).
mutate "s/  if \(row\.seal === 'reverted'\) \{/  if (row.seal === 'reverted' \&\& false) {\n    \/\/ unreachable in the mutated body\n  }\n  if (false) {/" && check "M8-retraction-not-gated" || true

control_after="$(snapshot)"
TOTAL=$((TOTAL + 1))
if [ "$control_before" = "$control_after" ]; then
  if run_pin; then
    echo "CONTROL green, tree byte-identical"
    CAUGHT=$((CAUGHT + 1))
  else
    echo "CONTROL red after restore"
    FAILED=$((FAILED + 1))
  fi
else
  echo "RESTORE FAILED — the tree differs after the ladder"
  FAILED=$((FAILED + 1))
fi

echo "---"
echo "caught $CAUGHT / $TOTAL"
[ "$FAILED" -eq 0 ] || exit 1
exit 0
