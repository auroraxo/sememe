#!/usr/bin/env bash
# tools/mutation-ladder-channel-parity.sh — the mutation ladder for
# tools/measure-channel-parity.mjs + its pin test/channel-parity.test.mjs.
#
# House convention: a measurement tool that cannot FAIL is not a measurement.
# Each mutation below edits a COPY of the measurement code (the working tree
# is never touched), re-runs it against the LIVE npm registry, and hands the
# resulting artifact to the committed pin via SEMEME_CHANNEL_PARITY_ARTIFACT.
# Every mutation must turn the pin red. An escape is a hole in the evidence.
#
# The mutated tool runs with --root pointing at the real repository, so the
# only difference between a mutation and the control is the mutated logic.
#
# THE MUTATIONS (each must be CAUGHT):
#
#   M1  classifyVersion stops seeing product files: every product divergence
#       collapses to `parity`  -> pin D2a (0.4.21 must be a product divergence
#       with exactly src/rawle.mjs) fails on the mutated artifact, and D1's
#       counters no longer match the summary either.
#   M2  isProductFile drops `src/` from the product prefixes -> src/rawle.mjs
#       is classified as a doc file: 0.4.21 becomes `doc-divergence`, D2a's
#       productFilesAffected expectation fails.
#   M3  compare() silently drops files that exist only on the registry side ->
#       onlyInRegistry becomes empty: D2a fails (it pins exactly
#       ['src/rawle.mjs']).
#   M4  the stub check is removed from classifyVersion -> 0.0.0-stage is
#       classified `no-tag` instead of `stage-placeholder`: D2e fails.
#   M5  the verdict is hard-coded to `channel-parity-clean` while the summary
#       still counts a divergence -> D1 (verdict must derive from summary)
#       fails.
#
# CONTROL (must be GREEN): the unmutated copy of the tool, run against the
# same live registry, produces an artifact the committed pin accepts — so a
# red result below is caused by the mutation, not by the ladder.
#
# Exit codes: 0 all mutations caught and the control green; 1 otherwise.
#
# Network: this ladder talks to the npm registry (npm pack of every published
# version, twice per run). Run it deliberately, not in the suite.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOL="tools/measure-channel-parity.mjs"
PIN="test/channel-parity.test.mjs"
WORK="$(mktemp -d /tmp/channel-parity-ladder.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

caught=0
escaped=0

log()  { printf '%s\n' "$*"; }
fail() { printf 'LADDER FAILED: %s\n' "$*"; exit 1; }

# Run a tool (already placed at $1) against the live registry into $2, then run
# the committed pin in the real repository with that artifact injected.
measure_with_pin() {
  local tool="$1" artifact="$2"
  if ! node "$tool" --root "$ROOT" --out "$artifact" >"$WORK/out.log" 2>&1; then
    log "  tool exited non-zero: $(tail -2 "$WORK/out.log" | tr '\n' ' ')"
    # an exit-3 NO VERDICT is not a catch by itself; fall through to the pin,
    # which will refuse a missing/incoherent artifact.
  fi
  ( cd "$ROOT" && SEMEME_CHANNEL_PARITY_ARTIFACT="$artifact" node --test "$PIN" \
    >"$WORK/pin.out" 2>"$WORK/pin.err" )
  local status=$?
  tail -5 "$WORK/pin.out" | sed 's/^/  /'
  return $status
}

run_mutation() {
  local idx="$1" name="$2" sedexpr="$3"
  log "--- M$idx $name"
  local mutated="$WORK/mutated-M$idx.mjs"
  cp "$ROOT/$TOOL" "$mutated"
  sed -i "$sedexpr" "$mutated"
  if cmp -s "$ROOT/$TOOL" "$mutated"; then
    fail "M$idx: the sed expression changed nothing — the mutation is not a mutation"
  fi
  if measure_with_pin "$mutated" "$WORK/artifact-M$idx.json"; then
    log "  ESCAPED: the pin stayed green under M$idx"
    escaped=$((escaped + 1))
  else
    log "  CAUGHT: pin red under M$idx"
    caught=$((caught + 1))
  fi
}

log "channel-parity mutation ladder (live registry, $(date -u +%FT%TZ))"

# --- CONTROL ---------------------------------------------------------------
log "--- CONTROL (unmutated copy)"
if measure_with_pin "$ROOT/$TOOL" "$WORK/artifact-control.json"; then
  log "  control green: the unmutated tool's artifact passes the pin"
else
  fail "control red — the ladder cannot judge anything"
fi

# --- MUTATIONS -------------------------------------------------------------
run_mutation 1 "product divergences collapse to parity" \
  "s/if (productDiff.length) return 'product-divergence';/if (productDiff.length) return 'parity';/"

run_mutation 2 "src/ no longer counts as a product file" \
  "s|const PRODUCT_PREFIXES = \['index.mjs', 'src/', 'interface/', 'vendor/', 'bin/'\];|const PRODUCT_PREFIXES = ['index.mjs', 'interface/', 'vendor/', 'bin/'];|"

run_mutation 3 "registry-only files are dropped from the comparison" \
  "s/if (r \&\& !t) onlyRegistry.push(k);/if (r \&\& !t) continue;/"

run_mutation 4 "the stage placeholder is not recognized" \
  "s/if (meta.stub) return 'stage-placeholder';/if (false) return 'stage-placeholder';/"

run_mutation 5 "the verdict is hard-coded clean" \
  "s|verdict: summary.productDivergence > 0|verdict: (summary.productDivergence > 0) ? 'channel-parity-clean' : (summary.docDivergence > 0 ? 'channel-parity-clean' : 'channel-parity-clean')|"

log ""
log "result: caught=$caught escaped=$escaped"
if [ "$escaped" -ne 0 ]; then
  exit 1
fi
exit 0
