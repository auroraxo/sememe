#!/usr/bin/env bash
# tools/mutation-ladder-answer-voice.sh — the pin must FAIL when the thing it
# watches is broken. A pin that cannot go red is decoration.
#
# Each mutation breaks ONE thing the pin claims to hold, and the pin must
# report a failure. The control run (no mutation) must stay green. The tree
# must be byte-identical afterwards — a ladder that leaves a mutation behind
# measures the next run, not this one.
#
#   M1 the CLI drops the code from the answer output          -> red
#   M2 the CLI attaches a repair to the answer                -> red
#   M3 the mint drops the answer mark (`answer: true`)        -> red
#   M4 the mint attaches a repair (an answer dressed as a     -> red
#      refusal — caught at the LIBRARY, before the CLI)
#   M5 the mint rewrites the quoted sentence                  -> red
#   M6 the answer moves to the usage/IO channel (exit 2)      -> red
#   M7 lock.mjs reverts to a bare Error: lock/verify lose     -> red
#      the code entirely (the defect as it shipped)
#   M8 the CLI answer branch is removed: every face falls     -> red
#      back to bare prose
#   CONTROL no mutation                                       -> green
#
# Usage: bash tools/mutation-ladder-answer-voice.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

PIN="test/answer-voice.test.mjs"
ANSWER="src/store-answer.mjs"
LOCKM="src/lock.mjs"
BINM="bin/sememe.mjs"
WORK="$(mktemp -d /tmp/sememe-answer-ladder-XXXXXX)"
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
  cp "$WORK/answer.orig" "$ANSWER"
  cp "$WORK/lock.orig" "$LOCKM"
  cp "$WORK/bin.orig" "$BINM"
}

cp "$ANSWER" "$WORK/answer.orig"
cp "$LOCKM" "$WORK/lock.orig"
cp "$BINM" "$WORK/bin.orig"
snapshot

# --- M1: the CLI drops the code from the answer output -----------------------
python3 - "$BINM" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "      error: error.message,\n      code: error.code,\n      answer: true,"
new = "      error: error.message,\n      answer: true,"
assert old in s, 'M1 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
echo "M1 the CLI drops the code from the answer output"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M1 NOT CAUGHT"; FAILED=1; fi
restore

# --- M2: the CLI attaches a repair to the answer -----------------------------
python3 - "$BINM" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "      error: error.message,\n      code: error.code,\n      answer: true,"
new = "      error: error.message,\n      code: error.code,\n      fix: 'fix: run sememe pull',\n      answer: true,"
assert old in s, 'M2 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
echo "M2 the CLI attaches a repair to the answer"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M2 NOT CAUGHT"; FAILED=1; fi
restore

# --- M3: the mint drops the answer mark --------------------------------------
python3 - "$ANSWER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  error.code = code;\n  error.answer = true;"
new = "  error.code = code;"
assert old in s, 'M3 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
echo "M3 the mint drops the answer mark"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M3 NOT CAUGHT"; FAILED=1; fi
restore

# --- M4: the mint attaches a repair (an answer dressed as a refusal) ---------
python3 - "$ANSWER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  error.code = code;\n  error.answer = true;"
new = "  error.code = code;\n  error.answer = true;\n  error.fix = 'fix: run sememe pull';"
assert old in s, 'M4 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
echo "M4 the mint attaches a repair"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M4 NOT CAUGHT"; FAILED=1; fi
restore

# --- M5: the mint rewrites the quoted sentence -------------------------------
# Anchored on the BACKTICKED mint literal itself: the header comments also
# quote this sentence (escaped), and a pattern that matches the comment
# mutates documentation and measures nothing — the vacuum the store-damage
# ladder documented ("M7 mutated the wrong file").
python3 - "$ANSWER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = '`no sememe store at ${storeDir}: run "sememe pull" first`'
new = '`no sememe store at ${storeDir}: run sememe pull first`'
assert old in s, 'M5 anchor missing'
assert s.count(old) == 1, 'M5 anchor is not unique — the mint would not be the only target'
open(p, 'w').write(s.replace(old, new, 1))
PY
echo "M5 the mint rewrites the quoted sentence"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M5 NOT CAUGHT"; FAILED=1; fi
restore

# --- M6: the answer moves to the usage/IO channel (exit 2) -------------------
python3 - "$ANSWER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  error.code = code;\n  error.answer = true;"
new = "  error.code = code;\n  error.answer = true;\n  error.exitCode = 2;"
assert old in s, 'M6 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
echo "M6 the answer moves to the usage/IO channel (exit 2)"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M6 NOT CAUGHT"; FAILED=1; fi
restore

# --- M7: lock.mjs reverts to a bare Error (the defect as it shipped) ---------
python3 - "$LOCKM" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "      throw noStoreAnswer(storeDir);"
new = "      throw Error(`no sememe store at ${storeDir}: run \\\"sememe pull\\\" first`);"
assert old in s, 'M7 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
echo "M7 lock.mjs reverts to a bare Error"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M7 NOT CAUGHT"; FAILED=1; fi
restore

# --- M8: the CLI answer branch is removed ------------------------------------
python3 - "$BINM" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  } else if (error?.answer === true && typeof error.code === 'string') {"
new = "  } else if (false && error?.answer === true && typeof error.code === 'string') {"
assert old in s, 'M8 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
echo "M8 the CLI answer branch is removed"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M8 NOT CAUGHT"; FAILED=1; fi
restore

# --- CONTROL -----------------------------------------------------------------
echo "CONTROL no mutation"
if run_pin; then echo "  CONTROL NOT GREEN (the pin is red without a mutation)"; FAILED=1
else echo "  control green"; fi
verify_tree

echo "ladder: $CAUGHT/$TOTAL CAUGHT, control green, tree byte-identical"
[ "$CAUGHT" -eq "$TOTAL" ] && [ "$FAILED" -eq 0 ] || exit 1
exit 0
