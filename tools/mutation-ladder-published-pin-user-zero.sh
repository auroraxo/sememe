#!/usr/bin/env bash
# tools/mutation-ladder-published-pin-user-zero.sh — the pin must FAIL when
# the thing it watches is broken. A pin that cannot go red is decoration.
#
# Each mutation breaks ONE thing the pin claims to hold, and the pin must
# report a failure. The control run (no mutation) must stay green. The tree
# must be byte-identical afterwards — a ladder that leaves a mutation behind
# measures the next run, not this one.
#
#   M1 the artifact names a tool that does not exist   -> D1 red
#   M2 a check in the artifact carries pass:false       -> D2 red
#   M3 the artifact's pin drifts off the README pin     -> D3 red
#   M4 the artifact carries a host path (/tmp/...)      -> D4 red
#   M5 the README carries a SECOND install pin          -> D5 red
#   M6 the tool installs from the checkout, not the
#      registry                                         -> G1 red
#   M7 the tool swallows a failed check and exits 0     -> G1 red
#   CONTROL no mutation                                -> green
#
# Usage: bash tools/mutation-ladder-published-pin-user-zero.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

ARTIFACT="research/published-pin-user-zero-2026-11-15.json"
TOOL="tools/measure-published-pin-user-zero.mjs"
PIN="test/published-pin-user-zero.test.mjs"
WORK="$(mktemp -d /tmp/sememe-pin-ladder-XXXXXX)"
CAUGHT=0
TOTAL=0
FAILED=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

snapshot() {
  # Byte-identical check: a mutation must not survive the run.
  ( cd "$ROOT" && find research test tools -type f \( -name '*.mjs' -o -name '*.json' -o -name '*.sh' \) -print0 \
      | sort -z | xargs -0 sha256sum ) > "$WORK/tree.sha"
}
verify_tree() {
  snapshot
  ( cd "$ROOT" && find research test tools -type f \( -name '*.mjs' -o -name '*.json' -o -name '*.sh' \) -print0 \
      | sort -z | xargs -0 sha256sum ) > "$WORK/tree.after.sha"
  if cmp -s "$WORK/tree.sha" "$WORK/tree.after.sha"; then
    echo "  tree byte-identical"
  else
    echo "  FAIL tree changed"
    FAILED=1
  fi
}

run_pin() {
  node --test "$PIN" > "$WORK/out.log" 2>&1
  local code=$?
  if [ $code -eq 0 ]; then echo "  PIN GREEN (mutation NOT caught)"; return 1; fi
  echo "  PIN RED (caught)"
  return 0
}

expect_red() {
  # expect_red <label> <mutation-commands...>
  local label="$1"; shift
  TOTAL=$((TOTAL + 1))
  echo "== $label"
  local backup="$WORK/backup.$TOTAL"
  cp "$ARTIFACT" "$backup.artifact"
  cp "$TOOL" "$backup.tool"
  cp "$PIN" "$backup.pin"
  cp README.md "$backup.readme"
  "$@"
  if run_pin; then
    echo "  CAUGHT"
    CAUGHT=$((CAUGHT + 1))
  else
    echo "  NOT CAUGHT"
    FAILED=1
  fi
  cp "$backup.artifact" "$ARTIFACT"
  cp "$backup.tool" "$TOOL"
  cp "$backup.pin" "$PIN"
  cp "$backup.readme" README.md
  verify_tree
}

mutate_tool_field() {
  node -e "
const fs=require('fs');
const p='$ARTIFACT';
const a=JSON.parse(fs.readFileSync(p,'utf8'));
a.tool='tools/does-not-exist.mjs';
fs.writeFileSync(p, JSON.stringify(a,null,2)+'\n');
"
}
mutate_check_pass() {
  node -e "
const fs=require('fs');
const p='$ARTIFACT';
const a=JSON.parse(fs.readFileSync(p,'utf8'));
a.checks[0].pass=false;
fs.writeFileSync(p, JSON.stringify(a,null,2)+'\n');
"
}
mutate_pin() {
  node -e "
const fs=require('fs');
const p='$ARTIFACT';
const a=JSON.parse(fs.readFileSync(p,'utf8'));
a.pin='v0.0.1';
fs.writeFileSync(p, JSON.stringify(a,null,2)+'\n');
"
}
mutate_host_path() {
  node -e "
const fs=require('fs');
const p='$ARTIFACT';
const a=JSON.parse(fs.readFileSync(p,'utf8'));
a.limits.push('scratch dir was /tmp/sememe-published-pin-XXXXXX');
fs.writeFileSync(p, JSON.stringify(a,null,2)+'\n');
"
}
mutate_second_pin() {
  node -e "
const fs=require('fs');
let r=fs.readFileSync('README.md','utf8');
// A SECOND, DIFFERENT tag: the same tag twice would deduplicate to one pin
// and the gate would (correctly) not fire — the mutation must be a real
// second pin.
r=r.replace(/npm install github:auroraxo\/sememe#v[0-9.]+\.[0-9.]+[-A-Za-z0-9.]*/, 'npm install github:auroraxo/sememe#v0.4.26 && npm install github:auroraxo/sememe#v0.4.27');
fs.writeFileSync('README.md', r);
"
}
mutate_local_install() {
  node -e "
const fs=require('fs');
let t=fs.readFileSync('$TOOL','utf8');
t=t.replace(\"['install', \`sememe@\${PIN_VERSION}\`\", \"['install', \`file:\${ROOT}\`\");
fs.writeFileSync('$TOOL', t);
"
}
mutate_swallow_failure() {
  node -e "
const fs=require('fs');
let t=fs.readFileSync('$TOOL','utf8');
t=t.replace('if (verdict !== \'measured\' || checks.some((c) => !c.pass)) process.exit(3);', 'if (false) process.exit(3);');
fs.writeFileSync('$TOOL', t);
"
}

expect_red "M1 the artifact names a tool that does not exist" mutate_tool_field
expect_red "M2 a check in the artifact carries pass:false" mutate_check_pass
expect_red "M3 the artifact's pin drifts off the README pin" mutate_pin
expect_red "M4 the artifact carries a host path" mutate_host_path
expect_red "M5 the README carries a SECOND install pin" mutate_second_pin
expect_red "M6 the tool installs from the checkout, not the registry" mutate_local_install
expect_red "M7 the tool swallows a failed check and exits 0" mutate_swallow_failure

echo "== CONTROL (no mutation)"
TOTAL=$((TOTAL + 1))
if node --test "$PIN" > "$WORK/control.log" 2>&1; then
  echo "  PIN GREEN (control)"
  CAUGHT=$((CAUGHT + 1))
else
  echo "  FAIL control is RED"
  FAILED=1
fi
verify_tree

echo "LADDER: $CAUGHT/$TOTAL CAUGHT"
[ "$FAILED" -eq 0 ] || exit 1
exit 0
