#!/usr/bin/env bash
# tools/mutation-ladder-argument-voice.sh — the pin must FAIL when the thing
# it watches is broken. A pin that cannot go red is decoration.
#
# Each mutation breaks ONE thing the pin claims to hold, and the pin must
# report a failure. The control run (no mutation) must stay green. The tree
# must be byte-identical afterwards — a ladder that leaves a mutation behind
# measures the next run, not this one. Every step MUTATES through a helper
# that refuses a pattern matching nothing, so a silent no-op can never be
# counted as caught (both lessons burned earlier ladders here).
#
#   M1 the mint drops the product code                      -> CLI tests red
#   M2 the mint drops the repair                             -> A3 + CLI red
#   M3 the mint moves the refusal to the work channel (1)    -> A3 + CLI red
#   M4 the mint drops the code from the printed sentence     -> A4 + CLI red
#   M5 the mint drops the subject sentence (bare code only)  -> A4 red
#   M6 two faces of the table share one code                 -> A1 red
#   M7 the CLI stops carrying the code onto stderr           -> CLI red
#   M8 the CLI drops the repair onto stderr                  -> CLI red
#   CONTROL no mutation                                      -> green
#
# Usage: bash tools/mutation-ladder-argument-voice.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

PIN="test/argument-voice.test.mjs"
MINT="src/argument-voice.mjs"
CLI="bin/sememe.mjs"
WORK="$(mktemp -d /tmp/sememe-arg-voice-ladder-XXXXXX)"
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

# mutate <file> <old-verbatim> <new-verbatim> <name>
# Literal replacement; FAILS the ladder if the pattern matches nothing, and
# prints the mutated line so a reader sees what actually changed.
mutate() {
  local file="$1" old="$2" new="$3" name="$4"
  python3 - "$file" "$old" "$new" <<'PY'
import sys, pathlib
path, old, new = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
text = path.read_text()
n = text.count(old)
if n != 1:
    print(f"PATTERN MATCHED {n} TIMES (need exactly 1): {old[:90]!r}", file=sys.stderr)
    sys.exit(1)
path.write_text(text.replace(old, new))
print(f"  mutated: {new.strip().splitlines()[0][:96]}")
PY
  if [ $? -ne 0 ]; then
    echo "  $name MUTATION DID NOT APPLY — ladder FAILED"
    return 1
  fi
  return 0
}

restore() {
  cp "$WORK/mint.orig" "$MINT"
  cp "$WORK/cli.orig" "$CLI"
}

cp "$MINT" "$WORK/mint.orig"
cp "$CLI" "$WORK/cli.orig"
snapshot

# --- M1: the mint drops the product code ---------------------------------------
if mutate "$MINT" '    code: face.code,
    fix: `fix: ${face.fix}`,' '    code: null,
    fix: `fix: ${face.fix}`,' M1; then
  if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M1 NOT CAUGHT"; FAILED=1; fi
  restore; verify_tree
else FAILED=1; fi

# --- M2: the mint drops the repair ----------------------------------------------
if mutate "$MINT" '    fix: `fix: ${face.fix}`,' '    fix: null,' M2; then
  if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M2 NOT CAUGHT"; FAILED=1; fi
  restore; verify_tree
else FAILED=1; fi

# --- M3: the mint moves the refusal onto the work channel -----------------------
if mutate "$MINT" '    exitCode: 2,
    argument: faceKey,' '    exitCode: 1,
    argument: faceKey,' M3; then
  if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M3 NOT CAUGHT"; FAILED=1; fi
  restore; verify_tree
else FAILED=1; fi

# --- M4: the mint drops the code from the printed sentence ----------------------
if mutate "$MINT" 'const error = new ArgumentRefusal(`${face.message} (${face.code})`, {' 'const error = new ArgumentRefusal(`${face.message}`, {' M4; then
  if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M4 NOT CAUGHT"; FAILED=1; fi
  restore; verify_tree
else FAILED=1; fi

# --- M5: the mint drops the subject sentence (bare code only) -------------------
if mutate "$MINT" 'const error = new ArgumentRefusal(`${face.message} (${face.code})`, {' 'const error = new ArgumentRefusal(`(${face.code})`, {' M5; then
  if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M5 NOT CAUGHT"; FAILED=1; fi
  restore; verify_tree
else FAILED=1; fi

# --- M6: two faces of the table share one code (codes collapse) -----------------
if mutate "$MINT" "  'decode-native:trailing': {
    code: 'decode-native-trailing-invalid'," "  'decode-native:trailing': {
    code: 'decode-trailing-invalid'," M6; then
  if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M6 NOT CAUGHT"; FAILED=1; fi
  restore; verify_tree
else FAILED=1; fi

# --- M7: the CLI stops carrying the code onto stderr ----------------------------
if mutate "$CLI" '    console.error(JSON.stringify({
      error: error.message,
      code: error.code,
      fix: error.fix,
    }));
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 2;' '    console.error(JSON.stringify({
      error: error.message,
    }));
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 2;' M7; then
  if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M7 NOT CAUGHT"; FAILED=1; fi
  restore; verify_tree
else FAILED=1; fi

# --- M8: the CLI drops the repair onto stderr -----------------------------------
if mutate "$CLI" '      error: error.message,
      code: error.code,
      fix: error.fix,
    }));
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 2;' '      error: error.message,
      code: error.code,
    }));
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 2;' M8; then
  if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M8 NOT CAUGHT"; FAILED=1; fi
  restore; verify_tree
else FAILED=1; fi

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
[ "$CAUGHT" -eq "$TOTAL" ] && [ "$FAILED" -eq 0 ]
