#!/usr/bin/env bash
# tools/mutation-ladder-token-encoder-fallback.sh — the pin must FAIL when
# the thing it watches is broken. A pin that cannot go red is decoration.
#
# Each mutation breaks ONE thing the pin claims to hold, and the pin must
# report a failure. The control run (no mutation) must stay green. The tree
# must be byte-identical afterwards — a ladder that leaves a mutation behind
# measures the next run, not this one.
#
#   M1 the encoder's metadata branch is deleted -> D1/D2/D3 red
#   M2 the wrapper prefixes the reason twice again (old normalizer) -> D4 red
#   M3 the fallback leaks into legacy SPL Token -> G1 red
#   M4 the artifact's fix-tree fixture number is hand-edited -> pin red
#   M5 the artifact drops one of its own limits -> pin red
#   M6 the artifact's prefix face stops showing the defect -> pin red
#   CONTROL no mutation                              -> green
#
# Usage: bash tools/mutation-ladder-token-encoder-fallback.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

ARTIFACT="research/token-encoder-fallback-2026-11-15.json"
PIN="test/token-encoder-fallback.test.mjs"
PIN_MEASURE="test/token-encoder-fallback-measurement.test.mjs"
SRC="src/token.mjs"
WORK="$(mktemp -d /tmp/sememe-encfb-ladder-XXXXXX)"
CAUGHT=0
TOTAL=0
FAILED=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

snapshot() {
  ( cd "$ROOT" && find research test tools src -type f \( -name '*.mjs' -o -name '*.json' -o -name '*.sh' \) -print0 \
      | sort -z | xargs -0 sha256sum ) > "$WORK/tree.sha"
}
verify_tree() {
  snapshot
  ( cd "$ROOT" && find research test tools src -type f \( -name '*.mjs' -o -name '*.json' -o -name '*.sh' \) -print0 \
      | sort -z | xargs -0 sha256sum ) > "$WORK/tree.after.sha"
  if cmp -s "$WORK/tree.sha" "$WORK/tree.after.sha"; then
    echo "  tree byte-identical"
  else
    echo "  FAIL tree changed"
    diff <(cat "$WORK/tree.sha") <(cat "$WORK/tree.after.sha") | head -5
    FAILED=1
  fi
}

run_pin() {
  # Returns 0 when the pin is RED (the defect was caught), 1 when green.
  node --test "$PIN" "$PIN_MEASURE" > "$WORK/out.log" 2>&1
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
  cp "$SRC" "$backup.src"
  "$@"
  if run_pin; then
    echo "  CAUGHT"
    CAUGHT=$((CAUGHT + 1))
  else
    echo "  NOT CAUGHT"
    FAILED=1
  fi
  cp "$backup.artifact" "$ARTIFACT"
  cp "$backup.src" "$SRC"
  verify_tree
}

mutate_delete_encoder_branch() {
  node -e "
const fs=require('fs');
const p='$SRC';
let t=fs.readFileSync(p,'utf8');
const marker='    if (hasTokenMetadataFallback(program) && tokenMetadataNames().includes(name)) {';
const index=t.indexOf(marker);
if (index<0) { console.error('marker not found'); process.exit(1); }
// Delete the branch and its body: the encoder refuses metadata names again.
const end=t.indexOf('    throw new TokenCodecError(\'unknown-variant\'', index);
if (end<0) { console.error('end marker not found'); process.exit(1); }
t=t.slice(0,index)+t.slice(end);
fs.writeFileSync(p,t);
"
}

mutate_double_reason() {
  node -e "
const fs=require('fs');
const p='$SRC';
let t=fs.readFileSync(p,'utf8');
const before=t;
t=t.replace(
  '  const detail = error.message.startsWith(prefix)',
  '  const detail = false && error.message.startsWith(prefix)');
if (t===before) { console.error('marker not found'); process.exit(1); }
fs.writeFileSync(p,t);
"
}

mutate_legacy_leak() {
  node -e "
const fs=require('fs');
const p='$SRC';
let t=fs.readFileSync(p,'utf8');
const before=t;
t=t.replace(
  \"  return program === TOKEN_METADATA_PROGRAM;\",
  '  return true; // mutated: the fallback leaks into every token program');
if (t===before) { console.error('marker not found'); process.exit(1); }
fs.writeFileSync(p,t);
"
}

mutate_artifact_fix_number() {
  node -e "
const fs=require('fs');
const p='$ARTIFACT';
const a=JSON.parse(fs.readFileSync(p,'utf8'));
a.worktree.face.fixtureReencoded='9/10';
fs.writeFileSync(p, JSON.stringify(a,null,2)+'\n');
"
}

mutate_artifact_drop_limit() {
  node -e "
const fs=require('fs');
const p='$ARTIFACT';
const a=JSON.parse(fs.readFileSync(p,'utf8'));
a.limits=a.limits.filter(l=>!/live foreign consumer/.test(l));
fs.writeFileSync(p, JSON.stringify(a,null,2)+'\n');
"
}

mutate_artifact_clean_prefix() {
  node -e "
const fs=require('fs');
const p='$ARTIFACT';
const a=JSON.parse(fs.readFileSync(p,'utf8'));
a.prefix.face.unknownVariantNames=[];
a.prefix.face.reasonDoubled=false;
fs.writeFileSync(p, JSON.stringify(a,null,2)+'\n');
"
}

snapshot
expect_red "M1 the encoder's metadata branch is deleted" mutate_delete_encoder_branch
expect_red "M2 the wrapper prefixes the reason twice again" mutate_double_reason
expect_red "M3 the fallback leaks into legacy SPL Token" mutate_legacy_leak
expect_red "M4 the artifact's fix-tree fixture number is hand-edited" mutate_artifact_fix_number
expect_red "M5 the artifact drops one of its own limits" mutate_artifact_drop_limit
expect_red "M6 the artifact's prefix face stops showing the defect" mutate_artifact_clean_prefix

TOTAL=$((TOTAL + 1))
echo "== CONTROL no mutation"
if run_pin; then
  echo "  CONTROL RED — the baseline itself is broken (the pins must be green before a mutation)"
  FAILED=1
else
  echo "  CONTROL GREEN (the baseline holds)"
fi

echo
echo "ladder: $CAUGHT/6 caught, control green"
if [ "$FAILED" -ne 0 ] || [ "$CAUGHT" -ne 6 ]; then exit 1; fi
exit 0
