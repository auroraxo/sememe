#!/usr/bin/env bash
# tools/mutation-ladder-store-damage-voice-published.sh — the published-
# channel pin must FAIL when the thing it watches is broken. A pin that
# cannot go red is decoration.
#
# The pin (test/store-damage-voice-published-measurement.test.mjs) reads the
# COMMITTED ARTIFACT of tools/measure-store-damage-voice-published.mjs — two
# PUBLISHED npm versions, one probe, both installed from the registry. Each
# mutation breaks ONE claim the artifact makes, and the pin must report a
# failure. The control run (no mutation) must stay green, and the tree must
# be byte-identical afterwards — a ladder that leaves a mutation behind
# measures the next run, not this one.
#
#   M1 the verdict says held although a published version still quotes
#      the kernel                                     -> red (verdict pinned)
#   M2 the FIXED published version is recorded leaking an errno -> red
#   M3 the FIXED published version is recorded unnamed -> red
#   M4 the FIXED published version is recorded repairless -> red
#   M5 a damage face drifted onto the usage channel (exit 2) -> red
#   M6 a damage face loses its code on the fixed version -> red
#   M7 a damage face loses its repair on the fixed version -> red
#   M8 a CONTROL changed verdict between the two published versions -> red
#   M9 the baseline is rewritten as clean (no defect on the carrier) -> red
#   M10 the artifact quotes a host path -> red
#   M11 the "installed" version no longer equals the requested version
#      (an unmeasurable install called clean)         -> red
#   CONTROL no mutation                               -> green
#
# Usage: bash tools/mutation-ladder-store-damage-voice-published.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

PIN="test/store-damage-voice-published-measurement.test.mjs"
ARTIFACT="research/store-damage-voice-published-2026-11-17.json"
WORK="$(mktemp -d /tmp/sememe-published-damage-ladder-XXXXXX)"
CAUGHT=0
TOTAL=11
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

# Returns 0 when the pin is RED (the mutation was caught), 1 when green.
run_pin() {
  node --test "$PIN" > "$WORK/out.log" 2>&1
  local code=$?
  if [ $code -eq 0 ]; then echo "  PIN GREEN"; return 1; fi
  echo "  PIN RED"
  return 0
}

restore() { cp "$WORK/artifact.orig" "$ARTIFACT"; }

cp "$ARTIFACT" "$WORK/artifact.orig"
snapshot

# mut <name> <python-body>
mut() {
  local name="$1"; shift
  python3 - "$ARTIFACT" <<PY || { echo "  $name ANCHOR MISSING"; FAILED=1; restore; return; }
import json, sys
p = sys.argv[1]
a = json.load(open(p))
$1
json.dump(a, open(p, 'w'), indent=2)
open(p, 'a').write('\n')
PY
  if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  $name NOT CAUGHT"; FAILED=1; fi
  restore; verify_tree
}

# M1 the verdict says held although the fixed published version leaks
mut M1 "a['verdict'] = 'store-damage-voice-held-on-the-published-channel'
a['fixedLeakedErrnoFaces'] = 2"

# M2 the FIXED published version is recorded leaking an errno
mut M2 "a['fixedLeakedErrnoFaces'] = 1"

# M3 the FIXED published version is recorded unnamed
mut M3 "a['fixedUnnamedFaces'] = 3"

# M4 the FIXED published version is recorded repairless
mut M4 "a['fixedRepairlessFaces'] = 1"

# M5 a damage face drifted onto the usage channel (exit 2)
mut M5 "a['fixedExits']['receiptIsFile'] = 2
a['fixedWrongChannelFaces'] = 1"

# M6 a damage face loses its code on the fixed version
mut M6 "a['fixedCodes']['objectRehash'] = None"

# M7 a damage face loses its repair on the fixed version
mut M7 "a['fixedRepairs']['objectMissing'] = None"

# M8 a CONTROL changed verdict between the two published versions
mut M8 "a['controlRegression'] = 1
a['controlRegressionNames'] = ['callerPathVoice']"

# M9 the baseline is rewritten as clean (no defect on the carrier)
mut M9 "a['preFixLeakedErrnoFaces'] = 0
a['preFixUnnamedFaces'] = 0
a['preFixRepairlessFaces'] = 0"

# M10 the artifact quotes a host path
mut M10 "a['hostPathLeak'] = True"

# M11 the installed version no longer equals the requested version
mut M11 "a['fixed']['installedVersion'] = '0.4.31'"

# --- CONTROL ----------------------------------------------------------------
if run_pin; then echo "  CONTROL NOT GREEN (the pin is red without a mutation)"; FAILED=1
else echo "  control green"; fi
verify_tree

echo "ladder: $CAUGHT/$TOTAL CAUGHT, control green, tree byte-identical"
[ "$CAUGHT" -eq "$TOTAL" ] && [ "$FAILED" -eq 0 ] || exit 1
exit 0
