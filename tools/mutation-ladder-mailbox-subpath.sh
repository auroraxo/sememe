#!/usr/bin/env bash
# tools/mutation-ladder-mailbox-subpath.sh — the shipped-reader pin must FAIL
# when the thing it watches is broken. A pin that cannot go red is decoration.
#
# Target: test/mailbox-subpath.test.mjs, the gate that says "the published
# package can consume a reeflog mailbox, and it honours both retraction
# signals". It was written RED against the pre-fix tree (7/7 red, because the
# surface did not exist: `sememe/mailbox` -> ERR_PACKAGE_PATH_NOT_EXPORTED) and
# GREEN after src/mailbox.mjs + the exports entry landed. This ladder proves
# the green is not an accident of a gate that cannot fail.
#
#   M1 the seal check is dropped            -> D3 red
#   M2 the retraction CHANNEL check is      -> D4 red
#       dropped (seal-only reader again)
#   M3 reorgOnlySignatures is never filled  -> D4 red (the two sources become
#                                              indistinguishable)
#   M4 channelRead is forced true           -> D5 red (a reader that never
#                                              asked claims it honoured)
#   M5 counts.rowsReverted stops counting   -> D3 red (the row vanishes
#                                              instead of being named)
#   M6 the exports entry for ./mailbox      -> D1 red (the consumer's door is
#       is removed                               the defect we measured)
#   M7 a retracted row falls through to the -> D3 red (the retracted claim,
#       envelope path                            reeflog issue #1)
#   M8 rowsWithoutInstructions stops        -> G2 red (debt becomes silence)
#       counting
#   CONTROL no mutation                     -> green
#
# Usage: bash tools/mutation-ladder-mailbox-subpath.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

PIN="test/mailbox-subpath.test.mjs"
MODULE="src/mailbox.mjs"
MANIFEST="package.json"
WORK="$(mktemp -d /tmp/sememe-mailbox-ladder-XXXXXX)"
CAUGHT=0
TOTAL=8
FAILED=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

snapshot() {
  ( cd "$ROOT" && find src bin test tools research -type f \( -name '*.mjs' -o -name '*.json' -o -name '*.sh' \) -print0 \
      | sort -z | xargs -0 sha256sum ) > "$WORK/tree.sha"
}
verify_tree() {
  snapshot
  ( cd "$ROOT" && find src bin test tools research -type f \( -name '*.mjs' -o -name '*.json' -o -name '*.sh' \) -print0 \
      | sort -z | xargs -0 sha256sum ) > "$WORK/tree.after.sha"
  if cmp -s "$WORK/tree.sha" "$WORK/tree.after.sha"; then
    echo "  tree byte-identical"
  else
    echo "  FAIL tree changed"
    diff "$WORK/tree.sha" "$WORK/tree.after.sha" | head -5
    FAILED=1
  fi
}

# Returns 0 when the pin is RED (the defect was caught), 1 when green.
run_pin() {
  node --test "$PIN" > "$WORK/out.log" 2>&1
  local code=$?
  if [ $code -eq 0 ]; then echo "  PIN GREEN"; return 1; fi
  echo "  PIN RED"
  return 0
}

restore() {
  cp "$WORK/module.orig" "$MODULE"
  cp "$WORK/manifest.orig" "$MANIFEST"
}

cp "$MODULE" "$WORK/module.orig"
cp "$MANIFEST" "$WORK/manifest.orig"
snapshot

# --- M1: the seal check is dropped -----------------------------------------
python3 - "$MODULE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "const revertedBySeal = row.seal === 'reverted';"
assert old in s, 'M1 anchor missing'
open(p, 'w').write(s.replace(old, "const revertedBySeal = false; // mutation", 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M1 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M2: the retraction channel check is dropped ----------------------------
python3 - "$MODULE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "const revertedByChannel = typeof row.signature === 'string' && reorgSignatures.has(row.signature);"
assert old in s, 'M2 anchor missing'
open(p, 'w').write(s.replace(old, "const revertedByChannel = false; // mutation", 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M2 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M3: the channel-only retraction is never named -------------------------
python3 - "$MODULE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "if (revertedByChannel && !revertedBySeal) reorgOnlySignatures.push(row.signature);"
assert old in s, 'M3 anchor missing'
open(p, 'w').write(s.replace(old, "// mutation: never named", 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M3 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M4: channelRead is forced true (a reader that never asked claims) -------
python3 - "$MODULE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "      channelRead: channelRead === true,"
assert old in s, 'M4 anchor missing'
open(p, 'w').write(s.replace(old, "      channelRead: true, // mutation", 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M4 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M5: the retraction stops being counted (the row vanishes) --------------
python3 - "$MODULE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "      rowsReverted,\n      revertedSignatures,"
assert old in s, 'M5 anchor missing'
open(p, 'w').write(s.replace(old, "      rowsReverted: 0, // mutation\n      revertedSignatures: [],", 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M5 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M6: the exports entry (the consumer's door) is removed -----------------
python3 - "$MANIFEST" <<'PY'
import sys, json
p = sys.argv[1]
d = json.load(open(p))
assert './mailbox' in d.get('exports', {}), 'M6 anchor missing'
del d['exports']['./mailbox']
json.dump(d, open(p, 'w'), indent=2)
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M6 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M7: a retracted row falls through to the envelope path -----------------
# The retraction guard `continue`s before the envelope is read; removing it
# restores the pre-fix behaviour the defect report measured: a row the chain
# unmade becomes a payload source.
python3 - "$MODULE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = """    if (revertedBySeal || revertedByChannel) {
      rowsReverted++;"""
new = """    if (false && (revertedBySeal || revertedByChannel)) { // mutation
      rowsReverted++;"""
assert old in s, 'M7 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M7 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M8: an envelope without instructions stops being debt ------------------
python3 - "$MODULE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "    if (!Array.isArray(envelope.instructions)) { rowsWithoutInstructions++; continue; }"
assert old in s, 'M8 anchor missing'
open(p, 'w').write(s.replace(old, "    if (!Array.isArray(envelope.instructions)) { continue; } // mutation: silent", 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M8 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- CONTROL ----------------------------------------------------------------
if run_pin; then echo "  CONTROL NOT GREEN (the pin is red without a mutation)"; FAILED=1
else echo "  control green"; fi
verify_tree

echo "ladder: $CAUGHT/$TOTAL CAUGHT, control green, tree byte-identical"
[ "$CAUGHT" -eq "$TOTAL" ] && [ "$FAILED" -eq 0 ] || exit 1
exit 0
