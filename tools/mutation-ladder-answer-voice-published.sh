#!/usr/bin/env bash
# tools/mutation-ladder-answer-voice-published.sh — the PUBLISHED-CHANNEL pin
# must FAIL when the thing it watches is broken. A pin that cannot go red is
# decoration.
#
# The published measurement is a claim about two npm packages. The claim can
# go false in several ways, and each must be caught:
#
#   M1 the carrier's defect is INVISIBLE to the measurement (the probe
#      stops asking the question)                        -> red
#   M2 the fixed version's answer is read as defective (the
#      verdict logic inverts)                            -> red
#   M3 the artifact's COUNTS are hand-edited away from what
#      the tool derives                                  -> red
#   M4 the artifact claims a version the tool never
#      installed (the claim is about a package nobody got)-> red
#   M5 the verdict name is rewritten to "held" while the
#      counts say otherwise                              -> red
#   M6 an ANSWER is read as repaired (the repairless rule
#      inverts) — the claim "answers never carry a fix"  -> red
#      can no longer fail
#   M7 a CONTROL answers differently between the two
#      published versions and nobody notices             -> red
#   CONTROL no mutation                                  -> green
#
# Usage: bash tools/mutation-ladder-answer-voice-published.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

PIN="test/answer-voice-published-measurement.test.mjs"
ARTIFACT="research/answer-voice-published-2026-11-17.json"
TOOL="tools/measure-answer-voice-published.mjs"
PROBE="tools/answer-voice-probe.mjs"
WORK="$(mktemp -d /tmp/sememe-answer-published-ladder-XXXXXX)"
CAUGHT=0
TOTAL=7
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
  cp "$WORK/artifact.orig" "$ARTIFACT"
  cp "$WORK/tool.orig" "$TOOL"
  cp "$WORK/probe.orig" "$PROBE"
}

cp "$ARTIFACT" "$WORK/artifact.orig"
cp "$TOOL" "$WORK/tool.orig"
cp "$PROBE" "$WORK/probe.orig"
snapshot

# --- M1: the probe stops asking the question --------------------------------
# The probe's answer reader always reports a code: the measurement can no
# longer see the carrier's defect, and the counts collapse to zero.
python3 - "$PROBE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "    code: parsed && typeof parsed.code === 'string' ? parsed.code : null,"
new = "    code: parsed && typeof parsed.code === 'string' ? parsed.code : 'always-set',"
assert old in s, 'M1 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M1 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M2: the verdict logic inverts ------------------------------------------
# The fixed version's faces are counted as unnamed: the claim must not pass
# because the LOGIC was flipped.
python3 - "$TOOL" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "const fixedUnnamed = answerFaces.filter((n) => !fixedRun.result.cases[n].code);"
new = "const fixedUnnamed = answerFaces.filter((n) => !!fixedRun.result.cases[n].code);"
assert old in s, 'M2 anchor missing'
open(p, 'w').write(s.replace(old, new, 1))
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M2 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M3: the artifact's counts are hand-edited -------------------------------
python3 - "$ARTIFACT" <<'PY'
import sys, json
p = sys.argv[1]
d = json.load(open(p))
d['verdict']['carrierUnnamedFaces'] = 0
d['verdict']['fixedUnnamedFaces'] = 99
json.dump(d, open(p, 'w'), indent=2)
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M3 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M4: the artifact claims a version nobody installed ----------------------
python3 - "$ARTIFACT" <<'PY'
import sys, json
p = sys.argv[1]
d = json.load(open(p))
d['fixed']['installed'] = '0.4.30'
json.dump(d, open(p, 'w'), indent=2)
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M4 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M5: the verdict NAME is rewritten while the counts stay bad -------------
python3 - "$ARTIFACT" <<'PY'
import sys, json
p = sys.argv[1]
d = json.load(open(p))
d['verdictName'] = 'answer-voice-held-on-the-published-channel'
d['verdict']['fixedUnnamedFaces'] = 3
d['verdict']['fixedRepairedFaces'] = 3
json.dump(d, open(p, 'w'), indent=2)
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M5 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M6: the repairless rule inverts -----------------------------------------
# A fabricated `fix` on every fixed face must turn the pin red — the claim
# "an answer never carries a repair" must be able to FAIL.
python3 - "$ARTIFACT" <<'PY'
import sys, json
p = sys.argv[1]
d = json.load(open(p))
for face in d['answerFaces']:
    d['detail'][face]['fixed']['fix'] = 'fix: run sememe pull'
d['verdict']['fixedRepairedFaces'] = d['verdict'].get('fixedRepairedFaces', 0)
json.dump(d, open(p, 'w'), indent=2)
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M6 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- M7: a control changes answer between the two versions -------------------
python3 - "$ARTIFACT" <<'PY'
import sys, json
p = sys.argv[1]
d = json.load(open(p))
ctrl = d['controlsDetail']
name = sorted(ctrl.keys())[0]
ctrl[name]['fixed']['exit'] = 99
d['verdict']['controlRegression'] = 0
json.dump(d, open(p, 'w'), indent=2)
PY
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M7 NOT CAUGHT"; FAILED=1; fi
restore; verify_tree

# --- CONTROL -----------------------------------------------------------------
if run_pin; then echo "  CONTROL NOT GREEN (the pin is red without a mutation)"; FAILED=1
else echo "  control green"; fi
verify_tree

echo "ladder: $CAUGHT/$TOTAL CAUGHT, control green, tree byte-identical"
[ "$CAUGHT" -eq "$TOTAL" ] && [ "$FAILED" -eq 0 ] || exit 1
exit 0
