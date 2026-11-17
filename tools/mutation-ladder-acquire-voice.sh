#!/usr/bin/env bash
# tools/mutation-ladder-acquire-voice.sh — the acquisition-voice pin must FAIL
# when the thing it watches is broken. A pin that cannot go red is decoration.
#
# Each mutation breaks ONE thing the pin claims to hold, and the pin must
# report a failure. The control run (no mutation) must stay green. The tree
# must be byte-identical afterwards — a ladder that leaves a mutation behind
# measures the next run, not this one.
#
# Pins: test/acquire-voice.test.mjs (the mint's contract) and
#       test/pull.test.mjs (the wiring into `sememe pull`).
#
#   M1 the mint drops the code from every refusal             -> red
#   M2 the mint drops the repair from every refusal           -> red
#   M3 all HTTP failures collapse to one code (a script       -> red
#      can no longer tell a rate limit from an outage)
#   M4 the transport refusal splices the raw kernel cause     -> red
#      back into the operator's sentence (V4 broken)
#   M5 the JSON-RPC refusal drops the endpoint's own message  -> red
#      (V5 broken — the defect as it shipped)
#   M6 the work channel collapses to the usage channel        -> red
#      (exit 1 failures answer on 2)
#   M7 the non-https refusal moves off the usage channel      -> red
#      (exit 2 invocation answers on 1)
#   M8 pull.mjs reverts to the shipped `RPC unavailable: …`   -> red
#      prose (the defect as it shipped, end to end)
#   M9 pull.mjs reverts to web3.js's words for a bad id       -> red
#      (the third party speaks for the product again)
#   CONTROL no mutation                                      -> green
#
# Usage: bash tools/mutation-ladder-acquire-voice.sh
# Exit 0 = every mutation was CAUGHT and the control stayed green.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

PIN1="test/acquire-voice.test.mjs"
PIN2="test/pull.test.mjs"
VOICE="src/acquire-voice.mjs"
PULL="src/pull.mjs"
WORK="$(mktemp -d /tmp/sememe-acquire-ladder-XXXXXX)"
CAUGHT=0
TOTAL=9
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

# Returns 0 when a pin is RED (the defect was caught), 1 when both are green.
run_pin() {
  node --test "$PIN1" "$PIN2" > "$WORK/out.log" 2>&1
  local code=$?
  if [ $code -eq 0 ]; then echo "  PINS GREEN"; return 1; fi
  echo "  PINS RED ($(grep -E '^# (fail|tests)' "$WORK/out.log" | tr '\n' ' '))"
  return 0
}

restore() {
  cp "$WORK/voice.orig" "$VOICE"
  cp "$WORK/pull.orig" "$PULL"
}

cp "$VOICE" "$WORK/voice.orig"
cp "$PULL" "$WORK/pull.orig"
snapshot

# --- M1: the mint drops the code from every refusal --------------------------
python3 - "$VOICE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "  error.code = code;\n"
assert s.count(old) == 1, 'M1 anchor missing or ambiguous'
open(p, 'w').write(s.replace(old, '', 1))
PY
echo "M1 the mint drops the code from every refusal"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M1 NOT CAUGHT"; FAILED=1; fi
restore

# --- M2: the mint drops the repair from every refusal ------------------------
python3 - "$VOICE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = '  error.fix = `fix: ${repair}`;\n'
assert s.count(old) == 1, 'M2 anchor missing or ambiguous'
open(p, 'w').write(s.replace(old, '', 1))
PY
echo "M2 the mint drops the repair from every refusal"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M2 NOT CAUGHT"; FAILED=1; fi
restore

# --- M3: all HTTP failures collapse to one code ------------------------------
# A script must be able to tell a rate limit (429) from an outage (500) from a
# refusal (403); collapsing the branches makes the endpoint indistinguishable.
python3 - "$VOICE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "    case 'http':\n"
new = ("    case 'http':\n"
       "      return refuse({ code: 'rpc-http-error', subject: `the endpoint ${url}`,\n"
       "        reason: `answered HTTP ${failure.status}`,\n"
       "        repair: 'check the --rpc URL', });\n")
assert s.count(old) == 1, 'M3 anchor missing or ambiguous'
open(p, 'w').write(s.replace(old, new, 1))
PY
echo "M3 all HTTP failures collapse to one code"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M3 NOT CAUGHT"; FAILED=1; fi
restore

# --- M4: the transport refusal splices the raw kernel cause into the sentence -
python3 - "$VOICE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "        reason: transportReason(failure.cause),\n"
new = "        reason: `${transportReason(failure.cause)} (${failure.cause ?? 'unknown'})`,\n"
assert s.count(old) == 1, 'M4 anchor missing or ambiguous'
open(p, 'w').write(s.replace(old, new, 1))
PY
echo "M4 the transport refusal splices the raw kernel cause into the sentence"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M4 NOT CAUGHT"; FAILED=1; fi
restore

# --- M5: the JSON-RPC refusal drops the endpoint's own message ---------------
# This is the shipped defect verbatim: only the numeric code survived.
python3 - "$VOICE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "${failure.rpcMessage ?? 'no message'}"
new = "'an endpoint error'"
assert s.count(old) == 1, 'M5 anchor missing or ambiguous'
open(p, 'w').write(s.replace(old, new, 1))
PY
echo "M5 the JSON-RPC refusal drops the endpoint's own message"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M5 NOT CAUGHT"; FAILED=1; fi
restore

# --- M6: the work channel collapses to the usage channel ---------------------
python3 - "$VOICE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "function refuse({ code, subject, reason, repair, exitCode = 1, cause }) {"
new = "function refuse({ code, subject, reason, repair, exitCode = 2, cause }) {"
assert s.count(old) == 1, 'M6 anchor missing or ambiguous'
open(p, 'w').write(s.replace(old, new, 1))
PY
echo "M6 the work channel collapses to the usage channel"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M6 NOT CAUGHT"; FAILED=1; fi
restore

# --- M7: the non-https refusal moves off the usage channel -------------------
python3 - "$VOICE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "    repair: 'pass an https:// endpoint with --rpc, e.g. --rpc https://api.mainnet-beta.solana.com',\n    exitCode: 2,"
new = "    repair: 'pass an https:// endpoint with --rpc, e.g. --rpc https://api.mainnet-beta.solana.com',\n    exitCode: 1,"
assert s.count(old) == 1, 'M7 anchor missing or ambiguous'
open(p, 'w').write(s.replace(old, new, 1))
PY
echo "M7 the non-https refusal moves off the usage channel"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M7 NOT CAUGHT"; FAILED=1; fi
restore

# --- M8: pull.mjs reverts to the shipped bare prose --------------------------
python3 - "$PULL" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "if (response.error) throw rpcRefusal(rpcUrl, response.failure);"
new = "if (response.error) throw Error(`RPC unavailable: ${response.error}`);"
assert s.count(old) == 1, 'M8 anchor missing or ambiguous'
open(p, 'w').write(s.replace(old, new, 1))
PY
echo "M8 pull.mjs reverts to the shipped bare prose"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M8 NOT CAUGHT"; FAILED=1; fi
restore

# --- M9: pull.mjs reverts to web3.js's words for a bad id --------------------
python3 - "$PULL" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "    throw programIdRefusal(input, 'is not a base58 program address');"
new = "    throw Error('Non-base58 character');"
assert s.count(old) == 1, 'M9 anchor missing or ambiguous'
open(p, 'w').write(s.replace(old, new, 1))
PY
echo "M9 pull.mjs reverts to web3.js's words for a bad id"
if run_pin; then CAUGHT=$((CAUGHT+1)); else echo "  M9 NOT CAUGHT"; FAILED=1; fi
restore

# --- CONTROL -----------------------------------------------------------------
echo "CONTROL no mutation"
if run_pin; then echo "  CONTROL NOT GREEN (the pins are red without a mutation)"; FAILED=1
else echo "  control green"; fi
verify_tree

echo "ladder: $CAUGHT/$TOTAL CAUGHT, control green, tree byte-identical"
[ "$CAUGHT" -eq "$TOTAL" ] && [ "$FAILED" -eq 0 ] || exit 1
exit 0
