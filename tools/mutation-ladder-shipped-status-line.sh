#!/usr/bin/env bash
# tools/mutation-ladder-shipped-status-line.sh — the pin must FAIL when the
# thing it watches is broken. A pin that cannot go red is decoration.
#
# Each mutation breaks ONE thing the pin claims to hold, and the pin must
# report a failure. The control run (no mutation) must stay green. The tree
# must be byte-identical afterwards — a ladder that leaves a mutation behind
# measures the next run, not this one.
#
#   M1 the artifact's verdict is softened to "clean"    -> D-hist red
#   M2 the artifact stops naming 0.4.38 as stale        -> D-hist red
#   M3 the artifact records 0.4.37 as stale             -> D-hist red
#   M4 the artifact leaks a host path                   -> D-clean red
#   M5 the artifact drops the zero-external-users limit -> D-clean red
#   M6 the prepublishOnly hook is removed from package.json -> G-prep red
#   M7 the gate defines the Status judge but never CALLS it -> G-wire red
#   M8 the gate's R5 problem text no longer names R5    -> G-wire red
#   M9 the gate's judge softens a stale Status to ok    -> G-agree red
#   CONTROL no mutation                                 -> green
#
# Usage: bash tools/mutation-ladder-shipped-status-line.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

ARTIFACT="research/shipped-status-line-2026-11-19.json"
PIN="test/shipped-status-line.test.mjs"
GATE="tools/gate-shipped-readme-pin.mjs"
PKG="package.json"
WORK="$(mktemp -d /tmp/sememe-status-ladder-XXXXXX)"
CAUGHT=0
TOTAL=0
FAILED=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

snapshot() {
  ( cd "$ROOT" && find research test tools src -type f \( -name '*.mjs' -o -name '*.json' -o -name '*.sh' \) -print0 \
      | sort -z | xargs -0 sha256sum; sha256sum "$PKG" ) > "$1"
}
verify_tree() {
  # Compare against the PRE-LADDER snapshot: a ladder that compares the tree
  # to itself after every mutation always reports "byte-identical", no matter
  # what it left behind. This is exactly the mistake a previous ladder made;
  # the restore must prove the tree is back to the state the control was
  # measured in.
  snapshot "$WORK/tree.after.sha"
  if cmp -s "$WORK/tree.before.sha" "$WORK/tree.after.sha"; then
    echo "  tree byte-identical"
  else
    echo "  FAIL tree changed"
    diff "$WORK/tree.before.sha" "$WORK/tree.after.sha" | head -5
    FAILED=1
  fi
}

run_pin() {
  # Returns 0 when the pin is RED (the defect was caught), 1 when green.
  node --test "$PIN" > "$WORK/out.log" 2>&1
  local code=$?
  if [ $code -eq 0 ]; then echo "  PIN GREEN"; return 1; fi
  local fails
  fails=$(grep -E '^\s+✖|^\s+not ok' "$WORK/out.log" | sed 's/^\s*//' | head -4 | tr '\n' ';')
  echo "  PIN RED (expected) — failing: $fails"
  return 0
}

expect_red() {
  local label="$1" mutator="$2"
  TOTAL=$((TOTAL + 1))
  echo "== $label"
  # A mutator that cannot apply its own marker exits non-zero: that is a
  # BROKEN mutation, never a catch. Counting it as caught is how a ladder
  # lies about itself.
  if ! "$mutator"; then
    echo "  MUTATOR FAILED — the mutation did not apply; not a catch"
    FAILED=1
    restore_artifact
    verify_tree
    return
  fi
  if run_pin; then
    CAUGHT=$((CAUGHT + 1))
  else
    echo "  NOT CAUGHT — the mutation survived"
    FAILED=1
  fi
  restore_artifact
  verify_tree
}

restore_artifact() {
  # Every mutation is undone before the next one runs — a ladder that stacks
  # mutations measures "the tree with M1..M9 applied", not M9.
  ( cd "$ROOT" && git checkout -- "$ARTIFACT" "$GATE" "$PKG" )
}

mutate_verdict_clean() { node -e '
const fs=require("fs"); const p="research/shipped-status-line-2026-11-19.json";
const t=fs.readFileSync(p,"utf8");
const n=t.replace(/"verdict": "shipped-status-line-stale"/, "\"verdict\": \"shipped-status-line-clean\"");
if(n===t){ console.error("marker not found"); process.exit(1); }
fs.writeFileSync(p,n);
'; }
mutate_hide_038() { node -e '
const fs=require("fs"); const p="research/shipped-status-line-2026-11-19.json";
const t=fs.readFileSync(p,"utf8");
const n=t.replace(/"version": "0.4.38",\s*"verdict": "stale-status"/, "\"version\": \"0.4.38\",\n    \"verdict\": \"clean\"");
if(n===t){ console.error("marker not found"); process.exit(1); }
fs.writeFileSync(p,n);
'; }
mutate_037_stale() { node -e '
const fs=require("fs"); const p="research/shipped-status-line-2026-11-19.json";
const t=fs.readFileSync(p,"utf8");
const n=t.replace(/"version": "0.4.37",\s*"verdict": "clean"/, "\"version\": \"0.4.37\",\n    \"verdict\": \"stale-status\"");
if(n===t){ console.error("marker not found"); process.exit(1); }
fs.writeFileSync(p,n);
'; }
mutate_host_path() { node -e '
const fs=require("fs"); const p="research/shipped-status-line-2026-11-19.json";
const t=fs.readFileSync(p,"utf8");
const n=t.replace(/"tool": "tools\/measure-shipped-status-line.mjs"/, "\"tool\": \"tools/measure-shipped-status-line.mjs\",\n  \"scratch\": \"/home/aurora/.sememe/status-line\"");
if(n===t){ console.error("marker not found"); process.exit(1); }
fs.writeFileSync(p,n);
'; }
mutate_drop_limit() { node -e '
const fs=require("fs"); const p="research/shipped-status-line-2026-11-19.json";
const t=fs.readFileSync(p,"utf8");
const n=t.replace(/.*zero external users.*\n/, "");
if(n===t){ console.error("marker not found"); process.exit(1); }
fs.writeFileSync(p,n);
'; }
mutate_unhook() { node -e '
const fs=require("fs"); const p="package.json";
const t=fs.readFileSync(p,"utf8");
const n=t.replace(/\s*"prepublishOnly": "node tools\/gate-shipped-readme-pin.mjs"/, "");
if(n===t){ console.error("marker not found"); process.exit(1); }
fs.writeFileSync(p,n);
'; }
mutate_unwired() { node -e '
const fs=require("fs"); const p="tools/gate-shipped-readme-pin.mjs";
const t=fs.readFileSync(p,"utf8");
const n=t.replace("const status = judgeStatus({ readme: extract.stdout, version: shippedVersion });", "const status = { ok: true, status: null, problems: [] };");
if(n===t){ console.error("marker not found"); process.exit(1); }
fs.writeFileSync(p,n);
'; }
mutate_problem_text() { node -e '
const fs=require("fs"); const p="tools/gate-shipped-readme-pin.mjs";
const t=fs.readFileSync(p,"utf8");
// The SENTENCE the channel prints, not a comment mentioning R5: mutating the
// comment would be a no-op that the ladder could count as a catch.
const n=t.replace("R5 the shipped README\u0027s Status line says", "R5 the shipped readme\u0027s status line says");
if(n===t){ console.error("marker not found"); process.exit(1); }
fs.writeFileSync(p,n);
'; }
mutate_soften_stale() { node -e '
const fs=require("fs"); const p="tools/gate-shipped-readme-pin.mjs";
const t=fs.readFileSync(p,"utf8");
const n=t.replace("if (status !== `v${version}`) {", "if (false) {");
if(n===t){ console.error("marker not found"); process.exit(1); }
fs.writeFileSync(p,n);
'; }

snapshot "$WORK/tree.before.sha"
expect_red "M1 the artifact's verdict is softened to clean" mutate_verdict_clean
expect_red "M2 the artifact stops naming 0.4.38 as stale" mutate_hide_038
expect_red "M3 the artifact records 0.4.37 as stale" mutate_037_stale
expect_red "M4 the artifact leaks a host path" mutate_host_path
expect_red "M5 the artifact drops the zero-external-users limit" mutate_drop_limit
expect_red "M6 the prepublishOnly hook is removed from package.json" mutate_unhook
expect_red "M7 the gate defines the Status judge but never CALLS it" mutate_unwired
expect_red "M8 the gate's R5 problem text no longer names R5" mutate_problem_text
expect_red "M9 the gate's judge softens a stale Status to ok" mutate_soften_stale

TOTAL=$((TOTAL + 1))
echo "== CONTROL no mutation"
if run_pin; then
  echo "  CONTROL RED — the baseline itself is broken (the pin must be green before a mutation)"
  FAILED=1
else
  echo "  CONTROL GREEN (the baseline holds)"
fi

echo
echo "ladder: $CAUGHT/9 caught, control green"
if [ "$FAILED" -ne 0 ] || [ "$CAUGHT" -ne 9 ]; then exit 1; fi
exit 0
