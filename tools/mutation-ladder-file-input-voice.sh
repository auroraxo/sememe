#!/usr/bin/env bash
# tools/mutation-ladder-file-input-voice.sh — the pin must FAIL when the
# thing it watches is broken. A pin that cannot go red is decoration.
#
# Each mutation breaks ONE thing the pin claims to hold, and the pin must
# report a failure. The control run (no mutation) must stay green. The tree
# must be byte-identical afterwards — a ladder that leaves a mutation behind
# measures the next run, not this one.
#
#   M1 the classifier softens `missing` to the kernel's own errno -> D1 red
#   M2 the classifier drops the code (the refusal becomes unnamed) -> D2 red
#   M3 the classifier drops the repair line                   -> D3 red
#   M4 an IO refusal takes the work channel (exit 1)          -> D4 red
#   M5 the classifier lets a raw errno back into the message  -> D5 red
#   M6 the CLI stops carrying the code onto stderr            -> D6 red
#   M7 the CLI drops the repair onto stderr                  -> D7 red
#   M8 the content face is moved onto the IO channel         -> D8 red
#   CONTROL no mutation                                      -> green
#
# Usage: bash tools/mutation-ladder-file-input-voice.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

PIN="test/file-input-voice.test.mjs"
CLASSIFIER="src/file-input.mjs"
CLI="bin/sememe.mjs"
WORK="$(mktemp -d /tmp/sememe-file-voice-ladder-XXXXXX)"
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
    diff <(cat "$WORK/tree.sha") "$WORK/tree.after.sha" | head -5
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
  cp "$WORK/classifier.orig" "$CLASSIFIER"
  cp "$WORK/cli.orig" "$CLI"
}

cp "$CLASSIFIER" "$WORK/classifier.orig"
cp "$CLI" "$WORK/cli.orig"
snapshot

# --- M1: the classifier softens `missing` to the kernel's own errno ----------
perl -0pi -e "s/missing: 'does not exist'/missing: 'ENOENT: no such file or directory'/" "$CLASSIFIER"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M1 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M2: the classifier drops the code --------------------------------------
perl -0pi -e "s/const code = \`\\\$\{label\}-file-\\\$\{kind\}\`;/const code = null;/" "$CLASSIFIER"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M2 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M3: the classifier drops the repair ------------------------------------
perl -0pi -e "s/error\.fix = \`fix: \\\$\{repair\}\`;/error.fix = null;/" "$CLASSIFIER"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M3 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M4: an IO refusal takes the work channel --------------------------------
# The CHANNEL is the classifier's default: every IO face travels on exit 2
# because it never overrides it. Moving that default to the work channel
# must make every IO face red — a face that keeps its own exitCode (the
# content faces do) must NOT be able to hide the change.
perl -0pi -e "s/kind, exitCode = 2 \}\)/kind, exitCode = 1 })/" "$CLASSIFIER"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M4 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M5: the classifier lets a raw errno back into the message ----------------
perl -0pi -e "s/const error = new Error\(\`sememe \\\$\{label\}: the \\\$\{subject\} \\\$\{filePath\} \\\$\{reason\} \(\\\$\{code\}\)\`\);/const error = new Error(\`sememe \\\$\{label\}: the \\\$\{subject\} \\\$\{filePath\} \\\$\{reason\} (\\\$\{code\\\}) EISDIR: illegal operation on a directory\`);/" "$CLASSIFIER"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M5 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M6: the CLI stops carrying the code onto stderr -------------------------
perl -0pi -e "s/\{ error: error\.message, code: error\.code, fix: error\.fix \}/{ error: error.message }/" "$CLI"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M6 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M7: the CLI drops the repair onto stderr --------------------------------
perl -0pi -e "s/\{ error: error\.message, code: error\.code, fix: error\.fix \}/{ error: error.message, code: error.code }/" "$CLI"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M7 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M8: the content face is moved onto the IO channel -----------------------
perl -0pi -e "s/label, subject, filePath, kind: 'not_json', exitCode: 1,/label, subject, filePath, kind: 'not_json',/" "$CLASSIFIER"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M8 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- CONTROL -----------------------------------------------------------------
echo "CONTROL (no mutation):"
node --test "$PIN" > "$WORK/out.log" 2>&1
if [ $? -eq 0 ]; then
  echo "  PIN GREEN (control OK)"
else
  echo "  CONTROL RED — the pin is broken on the unmutated tree"
  FAILED=1
fi
verify_tree

echo
echo "caught $CAUGHT/$TOTAL"
echo "CAUGHT=$CAUGHT FAILED=$FAILED"
[ "$CAUGHT" -eq 8 ] && [ "$FAILED" -eq 0 ]
