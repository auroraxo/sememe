#!/usr/bin/env bash
# tools/mutation-ladder-shipped-readme-pin.sh — the pin must FAIL when the
# thing it watches is broken. A pin that cannot go red is decoration.
#
# Each mutation breaks ONE thing the pin claims to hold, and the pin must
# report a failure. The control run (no mutation) must stay green. The tree
# must be byte-identical afterwards — a ladder that leaves a mutation behind
# measures the next run, not this one.
#
#   M1 the artifact's verdict is softened to "clean"    -> D2 red
#   M2 the artifact's two-pins count is hand-edited    -> D2 red
#   M3 the artifact stops naming 0.4.28 as defective   -> D3 red
#   M4 the artifact leaks a host path                   -> D4 red
#   M5 the artifact drops the zero-external-users limit -> D4 red
#   M6 this tree is recorded as shipping two pins       -> D5 red
#   M7 the prepublishOnly hook is removed from package.json -> D6 red
#   M8 the gate's refusal is softened into a warning    -> G3 red
#   CONTROL no mutation                                 -> green
#
# Usage: bash tools/mutation-ladder-shipped-readme-pin.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

ARTIFACT="research/shipped-readme-pin-2026-11-15.json"
PIN="test/shipped-readme-pin.test.mjs"
GATE="tools/gate-shipped-readme-pin.mjs"
PKG="package.json"
WORK="$(mktemp -d /tmp/sememe-shipped-pin-ladder-XXXXXX)"
CAUGHT=0
TOTAL=0
FAILED=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

snapshot() {
  ( cd "$ROOT" && find research test tools src -type f \( -name '*.mjs' -o -name '*.json' -o -name '*.sh' \) -print0 \
      | sort -z | xargs -0 sha256sum; sha256sum "$PKG" ) > "$WORK/tree.sha"
}
verify_tree() {
  snapshot
  ( cd "$ROOT" && find research test tools src -type f \( -name '*.mjs' -o -name '*.json' -o -name '*.sh' \) -print0 \
      | sort -z | xargs -0 sha256sum; sha256sum "$PKG" ) > "$WORK/tree.after.sha"
  if cmp -s "$WORK/tree.sha" "$WORK/tree.after.sha"; then
    echo "  tree byte-identical"
  else
    echo "  FAIL tree changed"
    diff <(cat "$WORK/tree.sha") "$WORK/tree.after.sha" | head -5
    FAILED=1
  fi
}

run_pin() {
  # Returns 0 when the pin is RED (the defect was caught), 1 when green.
  node --test "$PIN" > "$WORK/out.log" 2>&1
  local code=$?
  if [ $code -eq 0 ]; then echo "  PIN GREEN"; return 1; fi
  echo "  PIN RED (caught: $(grep -cE '^✖ ' "$WORK/out.log") failing)"
  return 0
}

expect_red() {
  local label="$1"; shift
  TOTAL=$((TOTAL + 1))
  echo "== $label"
  local backup="$WORK/backup.$TOTAL"
  cp "$ARTIFACT" "$backup.artifact"
  cp "$GATE" "$backup.gate"
  cp "$PKG" "$backup.pkg"
  "$@"
  if run_pin; then
    echo "  CAUGHT"
    CAUGHT=$((CAUGHT + 1))
  else
    echo "  NOT CAUGHT"
    FAILED=1
  fi
  cp "$backup.artifact" "$ARTIFACT"
  cp "$backup.gate" "$GATE"
  cp "$backup.pkg" "$PKG"
  verify_tree
}

mutate_verdict_clean() {
  node -e "
const fs=require('fs');
const p='$ARTIFACT';
const a=JSON.parse(fs.readFileSync(p,'utf8'));
a.verdict='shipped-readme-pins-clean';
fs.writeFileSync(p, JSON.stringify(a,null,2)+'\n');
"
}

mutate_count() {
  node -e "
const fs=require('fs');
const p='$ARTIFACT';
const a=JSON.parse(fs.readFileSync(p,'utf8'));
a.counts.twoPins=0;
fs.writeFileSync(p, JSON.stringify(a,null,2)+'\n');
"
}

mutate_hide_028() {
  node -e "
const fs=require('fs');
const p='$ARTIFACT';
const a=JSON.parse(fs.readFileSync(p,'utf8'));
const row=a.versions.find(r=>r.version==='0.4.28');
row.verdict='clean';
row.pins=['v0.4.28'];
fs.writeFileSync(p, JSON.stringify(a,null,2)+'\n');
"
}

mutate_host_path() {
  node -e "
const fs=require('fs');
const p='$ARTIFACT';
const a=JSON.parse(fs.readFileSync(p,'utf8'));
a.note='measured in /home/aurora/github_repos/sememe';
fs.writeFileSync(p, JSON.stringify(a,null,2)+'\n');
"
}

mutate_drop_limit() {
  node -e "
const fs=require('fs');
const p='$ARTIFACT';
const a=JSON.parse(fs.readFileSync(p,'utf8'));
a.limits=a.limits.filter(l=>!/zero external users/i.test(l));
fs.writeFileSync(p, JSON.stringify(a,null,2)+'\n');
"
}

mutate_tree_dirty() {
  node -e "
const fs=require('fs');
const p='$ARTIFACT';
const a=JSON.parse(fs.readFileSync(p,'utf8'));
a.thisTree.pins=['v0.4.28','v0.4.27'];
a.thisTree.verdict='two-pins';
fs.writeFileSync(p, JSON.stringify(a,null,2)+'\n');
"
}

mutate_unhook() {
  node -e "
const fs=require('fs');
const p='$PKG';
const a=JSON.parse(fs.readFileSync(p,'utf8'));
delete a.scripts.prepublishOnly;
fs.writeFileSync(p, JSON.stringify(a,null,2)+'\n');
"
}

mutate_soften_gate() {
  node -e "
const fs=require('fs');
const p='$GATE';
let t=fs.readFileSync(p,'utf8');
const before=t;
t=t.replace('  process.exit(1);','  console.warn(\"shipped-readme-pin REFUSED (softened)\");\n  process.exit(0);');
if (t===before) { console.error('marker not found'); process.exit(1); }
fs.writeFileSync(p,t);
"
}

snapshot
expect_red "M1 the artifact's verdict is softened to clean" mutate_verdict_clean
expect_red "M2 the artifact's two-pins count is hand-edited" mutate_count
expect_red "M3 the artifact stops naming 0.4.28 as defective" mutate_hide_028
expect_red "M4 the artifact leaks a host path" mutate_host_path
expect_red "M5 the artifact drops the zero-external-users limit" mutate_drop_limit
expect_red "M6 this tree is recorded as shipping two pins" mutate_tree_dirty
expect_red "M7 the prepublishOnly hook is removed from package.json" mutate_unhook
expect_red "M8 the gate's refusal is softened into a warning" mutate_soften_gate

TOTAL=$((TOTAL + 1))
echo "== CONTROL no mutation"
if run_pin; then
  echo "  CONTROL RED — the baseline itself is broken (the pin must be green before a mutation)"
  FAILED=1
else
  echo "  CONTROL GREEN (the baseline holds)"
fi

echo
echo "ladder: $CAUGHT/8 caught, control green"
if [ "$FAILED" -ne 0 ] || [ "$CAUGHT" -ne 8 ]; then exit 1; fi
exit 0
