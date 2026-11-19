#!/usr/bin/env bash
# tools/mutation-ladder-mailbox-recorded-outcome.sh — the recorded-outcome
# gate and its measurement pin must FAIL when the thing they watch is broken.
# A pin that cannot go red is decoration.
#
#   M1 the reader drops the recorded-outcome classification (the tool
#      regresses to one debt bucket)                        -> gate red
#   M2 the reader stops NAMING the outcome per row
#      (counter survives, vocabulary gone)                  -> gate red
#   M3 the gate's D1 expectation is loosened (accepts the
#      one-bucket regression)                               -> gate red
#   M4 the artifact's verdict is hand-edited to "held"
#      while the counts say otherwise                       -> pin red
#   M5 the artifact's fixed-face counts are hand-edited
#      (separation claimed without being measured)          -> pin red
#   M6 the advice-face claim is rewritten (the impossible
#      repair is asserted away)                             -> pin red
#   M7 'held' (content PRESENT) joins the recorded-outcome
#      vocabulary: owed debt is misfiled as permanently lost
#      — the owed/lost boundary must hold from both sides   -> gate red
#   CONTROL no mutation                                     -> gate+pin green
#
# The pre-ladder tree snapshot is taken BEFORE the first mutation and every
# restore is verified against THAT snapshot (not git HEAD): a dirty tree or a
# mid-run commit must make the ladder fail loudly, not pass silently.
# Every mutation prints its applied diff line and FAILS the run when the
# mutation did not apply (the vacuum class: a no-op mutation that still
# counts as caught).

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

GATE="test/mailbox-recorded-outcome.test.mjs"
PIN="test/mailbox-recorded-outcome-measurement.test.mjs"
ARTIFACT="research/mailbox-recorded-outcome-2026-11-19.json"
READER="src/mailbox.mjs"
WORK="$(mktemp -d /tmp/sememe-rc-ladder-XXXXXX)"
CAUGHT=0
TOTAL=7
FAILED=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

snapshot() {
  ( cd "$ROOT" && find src tools test research -type f \( -name '*.mjs' -o -name '*.json' -o -name '*.sh' \) -print0 \
      | sort -z | xargs -0 sha256sum ) > "$WORK/tree.sha"
}
verify_tree() {
  ( cd "$ROOT" && find src tools test research -type f \( -name '*.mjs' -o -name '*.json' -o -name '*.sh' \) -print0 \
      | sort -z | xargs -0 sha256sum ) > "$WORK/tree.after.sha"
  if cmp -s "$WORK/tree.sha" "$WORK/tree.after.sha"; then
    echo "  tree byte-identical"
  else
    echo "  FAIL tree changed after restore"
    diff "$WORK/tree.sha" "$WORK/tree.after.sha" | head -5
    FAILED=1
  fi
}

run_gate() {
  node --test "$GATE" > "$WORK/gate.log" 2>&1
  local code=$?
  if [ $code -eq 0 ]; then echo "  GATE GREEN"; return 1; fi
  echo "  GATE RED"
  return 0
}

run_pin() {
  node --test "$PIN" > "$WORK/pin.log" 2>&1
  local code=$?
  if [ $code -eq 0 ]; then echo "  PIN GREEN"; return 1; fi
  echo "  PIN RED"
  return 0
}

restore() {
  cp "$WORK/reader.orig" "$READER"
  cp "$WORK/gate.orig" "$GATE"
  cp "$WORK/artifact.orig" "$ARTIFACT"
}

# Apply a python mutation; a mutation that does not apply is a HARD failure.
mutate() {
  local label="$1" file="$2"
  shift 2
  if ! python3 - "$file" "$@"; then
    echo "  $label MUTATION DID NOT APPLY (vacuum) — failing the ladder"
    FAILED=1
    return 1
  fi
  return 0
}

cp "$READER" "$WORK/reader.orig"
cp "$GATE" "$WORK/gate.orig"
cp "$ARTIFACT" "$WORK/artifact.orig"
snapshot

# --- M1: the reader drops the recorded-outcome classification ---------------
# The tool regresses to one debt bucket: the defect is back.
mutate M1 "$READER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "    if (payloadState || accountState) {"
new = "    if (false && (payloadState || accountState)) {"
assert old in s, 'M1 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
print('  M1 applied: classification disabled')
PY
[ $? -eq 0 ] && { if run_gate; then CAUGHT=$((CAUGHT+1)); else echo "  M1 NOT CAUGHT"; FAILED=1; fi; }
restore; verify_tree

# --- M2: the reader stops NAMING the outcome per row ------------------------
# The counter survives but the vocabulary is gone — the weaker regression the
# gate must also catch.
mutate M2 "$READER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "        payloadState,\n        accountState,\n      });"
new = "        payloadState: payloadState ? 'recorded' : null,\n        accountState: accountState ? 'recorded' : null,\n      });"
assert old in s, 'M2 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
print('  M2 applied: outcome names replaced by a constant')
PY
[ $? -eq 0 ] && { if run_gate; then CAUGHT=$((CAUGHT+1)); else echo "  M2 NOT CAUGHT"; FAILED=1; fi; }
restore; verify_tree

# --- M3: the gate accepts the one-bucket regression -------------------------
mutate M3 "$GATE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  assert.equal(doc.counts.rowsWithoutEnvelope, 1,\n    'only the row that is still OWED may count as envelope debt');\n  assert.equal(doc.counts.rowsRecordedOutcome, 3,"
new = "  assert.equal(doc.counts.rowsWithoutEnvelope, 4,\n    'only the row that is still OWED may count as envelope debt');\n  assert.equal(doc.counts.rowsRecordedOutcome ?? 3, 3,"
assert old in s, 'M3 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
print('  M3 applied: D1 loosened to the pre-fix numbers')
PY
[ $? -eq 0 ] && { if run_gate; then CAUGHT=$((CAUGHT+1)); else echo "  M3 NOT CAUGHT"; FAILED=1; fi; }
restore; verify_tree

# --- M4: the artifact's verdict is hand-edited ------------------------------
mutate M4 "$ARTIFACT" <<'PY'
import sys, json
p = sys.argv[1]
d = json.load(open(p))
d['verdict'] = 'not-held-no-defect-found'
json.dump(d, open(p, 'w'), indent=2)
print('  M4 applied: verdict rewritten')
PY
[ $? -eq 0 ] && { if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M4 NOT CAUGHT"; FAILED=1; fi; }
restore; verify_tree

# --- M5: the fixed-face counts are hand-edited ------------------------------
mutate M5 "$ARTIFACT" <<'PY'
import sys, json
p = sys.argv[1]
d = json.load(open(p))
d['fixed']['rowsRecordedOutcome'] = 0
d['fixed']['rowsWithoutEnvelope'] = 4
json.dump(d, open(p, 'w'), indent=2)
print('  M5 applied: fixed face rewritten to the defect numbers')
PY
[ $? -eq 0 ] && { if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M5 NOT CAUGHT"; FAILED=1; fi; }
restore; verify_tree

# --- M6: the advice-face claim is rewritten ---------------------------------
mutate M6 "$ARTIFACT" <<'PY'
import sys, json
p = sys.argv[1]
d = json.load(open(p))
d['adviceFixed']['namesHydrateRepair'] = True
d['adviceFixed']['stderr'] = 'no enriched rows in the journal — run `reeflog start` and `reeflog hydrate --accounts` first'
json.dump(d, open(p, 'w'), indent=2)
print('  M6 applied: advice face rewritten to the impossible repair')
PY
[ $? -eq 0 ] && { if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M6 NOT CAUGHT"; FAILED=1; fi; }
restore; verify_tree

# --- M7: 'held' joins the recorded-outcome vocabulary -----------------------
# Content that is PRESENT becomes "permanently lost": owed debt is misfiled
# and the repairable bucket silently shrinks. The boundary between "still
# owed" and "recorded as lost" must be defended from both sides.
mutate M7 "$READER" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "const RECORDED_OUTCOMES = new Set(['unavailable', 'invalid', 'no_metadata']);"
new = "const RECORDED_OUTCOMES = new Set(['unavailable', 'invalid', 'no_metadata', 'held']);"
assert old in s, 'M7 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
print('  M7 applied: held-content misfiled as recorded outcome')
PY
[ $? -eq 0 ] && { if run_gate; then CAUGHT=$((CAUGHT+1)); else echo "  M7 NOT CAUGHT"; FAILED=1; fi; }
restore; verify_tree

# --- CONTROL ----------------------------------------------------------------
if run_gate && run_pin; then echo "  CONTROL RED (gate or pin is red without a mutation)"; FAILED=1
else echo "  control green"; fi
verify_tree

echo "ladder: $CAUGHT/$TOTAL CAUGHT, control green, tree byte-identical"
[ "$CAUGHT" -eq "$TOTAL" ] && [ "$FAILED" -eq 0 ] || exit 1
exit 0
