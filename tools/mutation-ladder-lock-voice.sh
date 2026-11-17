#!/usr/bin/env bash
# tools/mutation-ladder-lock-voice.sh — the pin must FAIL when the thing it
# watches is broken. A pin that cannot go red is decoration.
#
# Each mutation breaks ONE thing the pin claims to hold, and the pin must
# report a failure. The control run (no mutation) must stay green. The tree
# must be byte-identical afterwards — a ladder that leaves a mutation behind
# measures the next run, not this one.
#
#   M1 the classifier hands the code back without a repair   -> red
#   M2 the classifier drops the code (refusal becomes unnamed)-> red
#   M3 the classifier puts the code at the FRONT, pushing the
#      quoted sentence out of position                       -> red
#   M4 the lock document fault takes the usage/IO channel
#      (exit 2) instead of the work channel                  -> red
#   M5 the gate stops carrying the violations payload        -> red
#   M6 the gate refusal carries a repair for a kind that
#      did not happen (the wrong repair)                     -> red
#   M7 a receipt-integrity refusal mints the code but drops
#      the repair again (the code is dropped by the channel) -> red
#   M8 the answer class swallows the refusal class: a missing
#      store acquires a code                                 -> red
#   CONTROL no mutation                                      -> green
#
# Usage: bash tools/mutation-ladder-lock-voice.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

PIN="test/lock-voice.test.mjs"
CLASSIFIER="src/lock-voice.mjs"
LOCKDOC="src/lock.mjs"
READER="src/store-read.mjs"
CLIPART="bin/sememe.mjs"
WORK="$(mktemp -d /tmp/sememe-lock-voice-ladder-XXXXXX)"
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
  cp "$WORK/classifier.orig" "$CLASSIFIER"
  cp "$WORK/lockdoc.orig" "$LOCKDOC"
  cp "$WORK/reader.orig" "$READER"
  cp "$WORK/clipart.orig" "$CLIPART"
}

cp "$CLASSIFIER" "$WORK/classifier.orig"
cp "$LOCKDOC" "$WORK/lockdoc.orig"
cp "$READER" "$WORK/reader.orig"
cp "$CLIPART" "$WORK/clipart.orig"
snapshot

# --- M1: the classifier hands the code back WITHOUT a repair ----------------
# The CLI's named channel prints code+fix ONLY when BOTH are present, so
# dropping `fix` silently demotes every refusal to {error} alone.
python3 - "$CLASSIFIER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  error.fix = `fix: ${repair}`;"
assert old in s, 'M1 anchor missing'
open(p, 'w').write(s.replace(old, "  // mutation: no repair", 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M1 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M2: the classifier drops the code (the refusal becomes unnamed) --------
python3 - "$CLASSIFIER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  error.code = code;"
assert old in s, 'M2 anchor missing'
open(p, 'w').write(s.replace(old, "  // mutation: no code", 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M2 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M3: the code is put at the FRONT, pushing the quoted sentence back -----
python3 - "$CLASSIFIER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  const sentence = text.includes(`(${code})`) ? text : `${text} (${code})`;"
new = "  const sentence = text.includes(`(${code})`) ? `(${code}) ${text}` : `${text} (${code})`;"
assert old in s, 'M3 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M3 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M4: the lock document fault takes the usage/IO channel -----------------
python3 - "$CLASSIFIER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "export function lockRefusal({ code, message, fix, violations = null, exitCode = 1 }) {"
new = "export function lockRefusal({ code, message, fix, violations = null, exitCode = 2 }) {"
assert old in s, 'M4 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M4 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M5: the gate stops carrying the violations payload ---------------------
python3 - "$CLASSIFIER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  if (violations) error.violations = violations;"
assert old in s, 'M5 anchor missing'
open(p, 'w').write(s.replace(old, "  // mutation: no violations payload", 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M5 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M6: the gate refuses with a repair for a kind that did not happen ------
python3 - "$LOCKDOC" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "      fix: mismatchRepair(kinds),"
new = "      fix: mismatchRepair(['relabelled']),"
assert old in s, 'M6 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M6 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M7: the receipt-integrity refusal mints the code but drops the repair --
python3 - "$READER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "    error.fix = `fix: ${integrity.fix}`;"
assert old in s, 'M7 anchor missing'
open(p, 'w').write(s.replace(old, "    // mutation: repair dropped again", 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M7 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M8: the answer class acquires a refusal's clothes ----------------------
# The missing-store ANSWER gets a code and a repair attached, so the CLI's
# named channel prints it as if it were a refusal — the C6 control (an answer
# must not be dressed up as a refusal) must catch it.
python3 - "$LOCKDOC" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = '      throw Error(`no sememe store at ${storeDir}: run "sememe pull" first`);'
new = '''      const answered = Error(`no sememe store at ${storeDir}: run "sememe pull" first`);
      answered.code = 'no-sememe-store';
      answered.fix = 'fix: run "sememe pull" first';
      throw answered;'''
assert old in s, 'M8 anchor missing'
# BOTH throw sites (writeLock and checkLock) are the answer; the control
# exercises checkLock, so both must be dressed up for the mutation to show.
open(p, 'w').write(s.replace(old, new))
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
