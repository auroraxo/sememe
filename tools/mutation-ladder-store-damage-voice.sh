#!/usr/bin/env bash
# tools/mutation-ladder-store-damage-voice.sh — the pin must FAIL when the
# thing it watches is broken. A pin that cannot go red is decoration.
#
# Each mutation breaks ONE thing the pin claims to hold, and the pin must
# report a failure. The control run (no mutation) must stay green. The tree
# must be byte-identical afterwards — a ladder that leaves a mutation behind
# measures the next run, not this one.
#
#   M1 the classifier hands the kernel's own strerror back      -> red
#   M2 the classifier drops the code (refusal becomes unnamed)  -> red
#   M3 the classifier drops the repair line                     -> red
#   M4 a damage refusal takes the usage/IO channel (exit 2)     -> red
#   M5 the reader quotes an ABSOLUTE store path again           -> red
#   M6 the reader stops classifying (raw errno escapes)         -> red
#   M7 the code is appended at the FRONT, pushing the quoted
#      sentence out of position                                 -> red
#   M8 the damage class swallows the caller-path class          -> red
#   CONTROL no mutation                                         -> green
#
# Usage: bash tools/mutation-ladder-store-damage-voice.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

PIN="test/store-damage-voice.test.mjs"
CLASSIFIER="src/store-damage.mjs"
READER="src/store-read.mjs"
PATHCLASS="src/store-input.mjs"
WORK="$(mktemp -d /tmp/sememe-store-damage-ladder-XXXXXX)"
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
  cp "$WORK/reader.orig" "$READER"
  cp "$WORK/pathclass.orig" "$PATHCLASS"
}

cp "$CLASSIFIER" "$WORK/classifier.orig"
cp "$READER" "$WORK/reader.orig"
cp "$PATHCLASS" "$WORK/pathclass.orig"
snapshot

# --- M1: the classifier hands the kernel's own strerror back ----------------
# The REASON text reaches the operator through the repair line, so the
# strerror wording lands in the refusal a script reads.
python3 - "$CLASSIFIER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "unreadable: 'make the file readable (chmod) and re-run \"sememe pull <program-id>\"',"
new = "unreadable: 'permission denied: make the file readable (chmod) and re-run \"sememe pull <program-id>\"',"
assert old in s, 'M1 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
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

# --- M3: the classifier drops the repair line -------------------------------
python3 - "$CLASSIFIER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  error.fix = `fix: ${repair}`;"
assert old in s, 'M3 anchor missing'
open(p, 'w').write(s.replace(old, "  // mutation: no repair", 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M3 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M4: a damage refusal takes the usage/IO channel ------------------------
python3 - "$CLASSIFIER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  error.exitCode = 1;"
assert old in s, 'M4 anchor missing'
open(p, 'w').write(s.replace(old, "  error.exitCode = 2;", 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M4 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M5: the reader quotes an ABSOLUTE store path again ---------------------
python3 - "$READER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "      message: `store receipt ${receiptName} is unreadable`,"
new = "      message: `store receipt ${path.join(storeDir, 'receipts', receiptName)} is unreadable`,"
assert old in s, 'M5 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M5 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M6: the reader stops classifying (raw errno escapes) -------------------
python3 - "$READER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = """    throw storeDamageRefusal({
      code: `store-receipt-${kind}`,
      kind,
      message: `store receipt ${receiptName} is unreadable`,
      path: receiptRelative,
    });"""
new = """    throw Error(`store receipt ${receiptName} is unreadable: ${String(error?.message ?? error)}`);"""
assert old in s, 'M6 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M6 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M7: the code is appended at the FRONT, pushing the quoted sentence back -
python3 - "$CLASSIFIER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  const error = new Error(detail ? `${head} (${code}) — ${detail}` : `${head} (${code})`);"
new = "  const error = new Error(detail ? `(${code}) ${head} — ${detail}` : `(${code}) ${head}`);"
assert old in s, 'M7 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M7 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M8: the damage class swallows the caller-path class --------------------
# isStoreDamageCode starts matching the PATH codes, so the two classes
# collapse — the caller-path control (exit 2, store-not_a_directory) breaks.
python3 - "$CLASSIFIER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  return typeof code === 'string' && /^store-(?:receipt|object)-[a-z_]+$/.test(code);"
new = "  return typeof code === 'string' && /^store-(?:(?:receipt|object)-)?[a-z_]+$/.test(code);"
assert old in s, 'M8 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
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
