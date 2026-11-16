#!/usr/bin/env bash
# tools/mutation-ladder-harvest-reorg-channel.sh — the retraction-channel pin
# must FAIL when the reader stops asking the channel. A pin that cannot go red
# is decoration.
#
# The contract under mutation (see test/harvest-reeflog-reorg-channel.test.mjs):
# a signature the retraction channel names must never become a payload source
# (whatever the row's seal says), must be NAMED rather than dropped, and the
# channel must be READ at all — a channel that cannot be read must fail the
# run rather than be silently skipped.
#
#   M1 the channel is never read at all        -> D1/D3/D4/F1/C1 red
#   M2 the channel is read but ignored          -> D1/D5 red
#   M3 the channel's cursor is the event one   -> C1 red
#   M4 an unreadable channel is ignored        -> F1 red
#   M5 the channel-only case is not separable  -> D2 red
#   M6 the channel delivery is not counted     -> D3/D6 red
#   M7 the retraction is treated as envelope   -> D2 red
#      debt instead of its own bucket
#   M8 the all-retracted refusal is softened   -> D5 red
#      (exit 0 + a document)
#   CONTROL no mutation                        -> green
#
# Usage: bash tools/mutation-ladder-harvest-reorg-channel.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

TOOL="tools/harvest-reeflog.mjs"
PIN="test/harvest-reeflog-reorg-channel.test.mjs"
WORK="$(mktemp -d /tmp/sememe-harvest-reorg-ladder-XXXXXX)"
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

# M1: the retraction channel is never read.
mutate "s/const reorgRun = await runReeflog\(\['reorg', 'tail', '--db', dbPath, '--cursor', reorgCursorPath, '--limit', String\(tailLimit\)\]\);/const reorgRun = { code: 0, out: '', err: '' };/" && check "M1-channel-not-read"

# M2: the channel is read but its records are thrown away.
mutate "s/const reorgSignatures = new Set\(reorgRetractions\.map\(\(r\) => r\.signature\)\);/const reorgSignatures = new Set();/" && check "M2-channel-ignored"

# M3: both channels share ONE cursor file.
mutate "s/const reorgCursorPath = path\.join\(cursorDir, 'reorgs-cursor\.txt'\);/const reorgCursorPath = cursorPath;/" && check "M3-cursors-shared"

# M4: a channel that cannot be read is ignored instead of failing the run.
mutate "s/if \(reorgRun\.code !== 0\) \{/if (false) {/" && check "M4-unreadable-channel-ignored"

# M5: a retraction only the channel knew about is not separable from a
# seal-only retraction.
mutate "s/    if \(revertedByChannel && !revertedBySeal\) reorgOnlySignatures\.push\(row\.signature\);/    \/\/ mutated: the two cases are not separable/" && check "M5-not-separable"

# M6: the channel's own delivery is not counted.
mutate "s/    reorgRetractions: reorgRetractions\.length,/    reorgRetractions: 0,/" && check "M6-delivery-not-counted"

# M7: the channel-retracted row lands in the envelope-debt bucket.
mutate "s/  const revertedByChannel = typeof row\.signature === 'string' && reorgSignatures\.has\(row\.signature\);/  const revertedByChannel = false;/" && check "M7-channel-not-gated"

# M8: a journal of only retracted rows reports success.
mutate "s/    process\.exit\(1\);\n  \}\n  console\.error\('no enriched rows/    process.exit(0);\n  }\n  console.error('no enriched rows/" && check "M8-all-retracted-success"

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
