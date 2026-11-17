#!/usr/bin/env bash
# tools/mutation-ladder-store-input-voice.sh — the pin must FAIL when the
# thing it watches is broken. A pin that cannot go red is decoration.
#
# Each mutation breaks ONE thing the pin claims to hold, and the pin must
# report a failure. The control run (no mutation) must stay green. The tree
# must be byte-identical afterwards — a ladder that leaves a mutation behind
# measures the next run, not this one.
#
#   M1 the classifier softens `not_a_directory` to the kernel's own text -> D1 red
#   M2 the classifier drops the code (the refusal becomes unnamed) -> D2 red
#   M3 the classifier drops the repair line                   -> D3 red
#   M4 an IO refusal takes the work channel (exit 1)          -> D4 red
#   M5 the classifier lets a raw errno back into the message  -> D5 red
#   M6 the store reader stops classifying (raw errno escapes) -> D6 red
#   M7 the write path stops classifying (raw errno escapes)   -> D7 red
#   M8 the conformance gate wraps the store refusal again     -> D8 red
#   M9 a missing store becomes a refusal (C5 breaks)          -> D9 red
#   CONTROL no mutation                                      -> green
#
# Usage: bash tools/mutation-ladder-store-input-voice.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

PIN="test/store-input-voice.test.mjs"
CLASSIFIER="src/store-input.mjs"
WRITER="src/store-write.mjs"
CONFORM="src/conformance.mjs"
WORK="$(mktemp -d /tmp/sememe-store-voice-ladder-XXXXXX)"
CAUGHT=0
TOTAL=9
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
  cp "$WORK/writer.orig" "$WRITER"
  cp "$WORK/conform.orig" "$CONFORM"
}

cp "$CLASSIFIER" "$WORK/classifier.orig"
cp "$WRITER" "$WORK/writer.orig"
cp "$CONFORM" "$WORK/conform.orig"
snapshot

# --- M1: the classifier softens `not_a_directory` to strerror's own text ----
perl -0pi -e "s/not_a_directory: 'cannot be used as a directory'/not_a_directory: 'not a directory'/" "$CLASSIFIER"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M1 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M2: the classifier drops the code --------------------------------------
perl -0pi -e "s/  error\.code = code;/  error.code = null;/" "$CLASSIFIER"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M2 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M3: the classifier drops the repair ------------------------------------
perl -0pi -e "s/  error\.fix = \`fix: \\\$\{repair\}\`;/  error.fix = null;/" "$CLASSIFIER"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M3 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M4: an IO refusal takes the work channel --------------------------------
# The CHANNEL is the classifier's default: every IO face travels on exit 2
# because it never overrides it. Moving that default to the work channel
# must make every IO face red.
perl -0pi -e "s/storePath, kind, exitCode = 2 \}\)/storePath, kind, exitCode = 1 })/" "$CLASSIFIER"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M4 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M5: the classifier lets a raw errno back into the message ---------------
perl -0pi -e "s/const error = new Error\(\`sememe store: the \\\$\{subject\} \\\$\{storePath\} \\\$\{reason\} \(\\\$\{code\}\)\`\);/const error = new Error(\`sememe store: the \\\$\{subject\\\} \\\$\{storePath\\\} \\\$\{reason\\\} (\\\$\{code\\\}) ENOTDIR: not a directory\`);/" "$CLASSIFIER"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M5 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M6: the receipt read stops classifying (raw errno escapes) --------------
# The receipt directory is read bare again: ENOTDIR and EACCES walk straight
# out of readStoreReceipts, exactly as they did before the fix. (The ENOENT
# case is untouched: a missing store must keep the caller's own sentence.)
perl -0pi -e "s/  try \{ return await readdir\(receipts\); \}\n  catch \(error\) \{/  try { return await readdir(receipts); }\n  catch (error) {\n    if (error?.code !== 'ENOENT') throw error; \/\/ mutated: no classification\n    if (false) {/" "$CLASSIFIER"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M6 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M7: the atomic writer stops classifying (raw errno escapes) --------------
# writeOnce maps its filesystem failures again, so an unwritable objects/
# directory answers with EACCES verbatim, as before the fix.
perl -0pi -e "s/    const kind = classifyStoreErrno\(error\);\n    const part = storePartOf\(destination\);/    const kind = classifyStoreErrno(error);\n    const part = storePartOf(destination);\n    if (kind) throw error; \/\/ mutated: refusal dropped/" "$WRITER"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M7 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M8: the conformance gate wraps the store refusal again -------------------
perl -0pi -e "s/        if \(isStoreInputCode\(code\)\) throw error;\n//" "$CONFORM"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M8 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M9: a missing store becomes a refusal (C5 breaks) ------------------------
# The reader answers a NONEXISTENT store with a named refusal instead of the
# original ENOENT — the sentence every README and test quotes disappears.
perl -0pi -e "s/    if \(kind === 'missing'\) throw error;\n    throw storeRefusal\(\{\n      code: \`store-receipts-\\\$\{kind\}\`, subject: 'receipts directory', storePath: receipts, kind,/    throw storeRefusal({\n      code: kind === 'missing' ? 'store-receipts-missing' : \`store-receipts-\\\$\{kind\}\`, subject: 'receipts directory', storePath: receipts, kind: kind === 'missing' ? 'unreadable' : kind,/" "$CLASSIFIER"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M9 NOT CAUGHT"; FAILED=1; fi
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
[ "$CAUGHT" -eq 9 ] && [ "$FAILED" -eq 0 ]
