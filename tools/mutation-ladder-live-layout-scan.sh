#!/usr/bin/env bash
# tools/mutation-ladder-live-layout-scan.sh — the mutation ladder for the
# live layout scan (tools/measure-live-layout-scan.mjs + its analyzer
# tools/lib/live-layout.mjs).
#
# The house convention: a measurement tool that cannot FAIL is not a
# measurement. This ladder mutates the measurement code (in a throwaway copy
# of the tree — the working tree is never touched) and proves that each
# mutation turns the evidence red: either the pin over the committed bytes
# fails, or the re-derivation verify against the artifact fails. A mutation
# that escapes is a hole in the evidence, not a passing test.
#
# THE MUTATIONS (each must be CAUGHT):
#
#   M1  the analyzer returns 'borsh-prefix' where the committed wire says
#       count-from-header  -> the COMMITTED BYTES pin goes red (it re-runs
#                              the same analyzer over the committed sample).
#   M2  the discriminator resolution is hard-coded to ONE byte -> CAMM's
#       8-byte sighashes are mislabelled; the committed-bytes sample no
#       longer reproduces the pinned discriminator set (pin red) and a
#       re-derivation from the pinned signatures changes its histogram
#       (verify red).
#   M3  the element sizer forgets `pubkey` -> CurvePointInput stays sized
#       through u64 fields, but SpreadTriggerKey-style elements become
#       unknown; the re-derivation verify over pinned signatures changes the
#       per-discriminator story only if bytes are affected — the pin over
#       the committed CAMM sample catches the mislabelling.
#   M4  missed transactions are silently pushed into the pinned signature
#       list as pseudo-entries -> scanned.signatures no longer matches the
#       histogram/payloads the artifact claims (verify red).
#   M5  the pinned signature list is truncated to 10 -> the re-derivation
#       cannot reproduce the artifact's payload counts (verify red).
#
# Exit codes: 0 all mutations caught and the control green; 1 a mutation
# escaped (or the control was red).

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOL="tools/measure-live-layout-scan.mjs"
LIB="tools/lib/live-layout.mjs"
PIN="test/live-layout-scan-measurement.test.mjs"
HADRO="research/live-layout-scan-hadro-2026-11-14.json"
CAMM="research/live-layout-scan-camm-2026-11-14.json"
WORK="$(mktemp -d /tmp/live-layout-ladder.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

caught=0
escaped=0

log()  { printf '%s\n' "$*"; }
fail() { printf 'LADDER FAILED: %s\n' "$*"; exit 1; }

prep() {
  rm -rf "$WORK/tree"
  mkdir -p "$WORK/tree/tools/lib" "$WORK/tree/test" "$WORK/tree/research"
  cp "$ROOT/$TOOL" "$WORK/tree/$TOOL"
  cp "$ROOT/$LIB"  "$WORK/tree/$LIB"
  cp "$ROOT/$PIN"  "$WORK/tree/$PIN"
  cp "$ROOT/$HADRO" "$WORK/tree/$HADRO"
  cp "$ROOT/$CAMM" "$WORK/tree/$CAMM"
  # The pin and tool read the committed store and src through the repo root.
  ln -sfn "$ROOT/test/fixtures" "$WORK/tree/test/fixtures"
  ln -sfn "$ROOT/src" "$WORK/tree/src"
}

run_pin() {
  ( cd "$WORK/tree" && node --test "$PIN" >"$WORK/pin.out" 2>&1 )
}

# Re-fetch the pinned signatures and verify against the committed artifact.
run_verify() {
  ( cd "$WORK/tree" && node "$TOOL" \
      --program HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8 \
      --from-signatures "$WORK/tree/$HADRO" \
      --out "$WORK/rederived.json" --verify "$WORK/tree/$HADRO" >"$WORK/verify.out" 2>&1 )
}

apply_mutation() {
  local id="$1"
  case "$id" in
    M1)
      sed -i "s|return { hypothesis: 'count-from-header', count, elementBytes, trailingBytes };|return { hypothesis: 'borsh-prefix', count, elementBytes, trailingBytes };|" "$WORK/tree/$LIB"
      ;;
    M2)
      sed -i "s|for (const length of map.lengths) {|for (const length of [1]) {|" "$WORK/tree/$LIB"
      ;;
    M3)
      sed -i "s|u64: 8, i64: 8, pubkey: 32,|u64: 8, i64: 8,|" "$WORK/tree/$LIB"
      ;;
    M4)
      # A real defect of the documented contract: failed transactions are
      # KEPT in the denominator (they are bytes the program was sent). This
      # mutation drops them as if they were missed — the re-derivation's
      # payload counts and histogram change.
      sed -i "s#if (!tx) { missed += 1; continue; }#if (!tx || tx.meta.err) { missed += 1; continue; }#g" "$WORK/tree/$TOOL"
      ;;
    M5)
      sed -i "s|const batch = artifact.pinnedSignatures ?? artifact.signatures;|const batch = (artifact.pinnedSignatures ?? artifact.signatures).slice(0, 10);|" "$WORK/tree/$TOOL"
      ;;
    *) fail "unknown mutation $id" ;;
  esac
}

# VAKUUM-GATE: every mutation must change the code it targets — a sed that
# matched nothing would "pass" the ladder for free.
vacuum_check() {
  local id="$1"
  case "$id" in
    M1) grep -q "hypothesis: 'borsh-prefix', count, elementBytes, trailingBytes };" "$WORK/tree/$LIB" ;;
    M2) grep -q "for (const length of \[1\])" "$WORK/tree/$LIB" ;;
    M3) ! grep -q "pubkey: 32" "$WORK/tree/$LIB" ;;
    M4) grep -q 'if (!tx || tx.meta.err) { missed += 1; continue; }' "$WORK/tree/$TOOL" ;;
    M5) grep -q "slice(0, 10)" "$WORK/tree/$TOOL" ;;
  esac
}

prep
run_pin || { log "CONTROL PIN RED:"; cat "$WORK/pin.out"; fail "control pin is not green"; }
log "control: pin green"
run_verify || { log "CONTROL VERIFY RED:"; cat "$WORK/verify.out"; fail "control re-derivation is not green"; }
log "control: re-derivation verify green"

for id in M1 M2 M3 M4 M5; do
  prep
  apply_mutation "$id"
  if ! vacuum_check "$id"; then
    log "$id: VACUUM (mutation did not change the code) — FAIL"
    escaped=$((escaped + 1))
    continue
  fi
  # The pin is offline (committed bytes) and fast; the verify re-fetches
  # the pinned signatures and is slow. Run the verify only when the pin
  # cannot see the mutation — that keeps the ladder from paying for evidence
  # it already has.
  if ! run_pin; then
    caught=$((caught + 1))
    log "$id: CAUGHT by the committed-bytes pin (verify skipped)"
    continue
  fi
  if ! run_verify; then
    caught=$((caught + 1))
    log "$id: CAUGHT by the re-derivation verify"
    continue
  fi
  escaped=$((escaped + 1))
  log "$id: ESCAPED (pin=green verify=green)"
done

log "ladder summary: caught=$caught escaped=$escaped"
[ "$escaped" -eq 0 ] || fail "$escaped mutation(s) escaped"
exit 0
