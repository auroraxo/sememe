#!/usr/bin/env bash
# The pinned-install journey for v0.4.5: the three base58 defects, measured
# against the PUBLISHED install (npm install github:auroraxo/sememe#v0.4.5),
# not against a working tree.
#
# Run: bash tools/journey-v0.4.5.sh [workdir]
# Exit 0 = every case decoded, base58 and hex byte-identical.
set -u

WORK="${1:-$(mktemp -d /tmp/sememe-journey-v045-XXXXXX)}"
FIXTURE="$(cd "$(dirname "$0")/.." && pwd)/test/fixtures/traffic-sample-store-2026-11-04-pulled"
STORE="$WORK/store"
FAIL=0
say() { printf '%s\n' "$*"; }
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then say "  OK   $1"
  else say "  FAIL $1 (expected [$2], got [$3])"; FAIL=1; fi
}

mkdir -p "$WORK"
if [ ! -d "$WORK/node_modules/sememe" ]; then
  say "== installing the published tag into $WORK"
  (cd "$WORK" && npm init -y >/dev/null 2>&1 &&
    npm install --no-audit --no-fund github:auroraxo/sememe#v0.4.5 2>&1 | tail -2) || exit 2
fi
check "installed version is 0.4.5" "0.4.5" \
  "$(node -e "console.log(require('$WORK/node_modules/sememe/package.json').version)")"
cp -r "$FIXTURE" "$STORE"
cd "$WORK"

say "== D1: base58 payload on the union path (v0.4.4 refused every one)"
OUT=$(npx sememe decode --union 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P \
  3c5s1W8njd3Hcyadj9sY46ZmGiUYCxR8b --store "$STORE" 2>&1)
printf '%s\n' "$OUT" | grep -q 'needs the payload bytes as a Buffer' \
  && { say "  FAIL still refused as non-Buffer"; FAIL=1; } || say "  OK   not refused"
check "instruction" '"name": "sell_v3"' "$(printf '%s' "$OUT" | grep -o '"name": "sell_v3"' | head -1)"
check "roundTripByteExact" '"roundTripByteExact": true' \
  "$(printf '%s' "$OUT" | grep -o '"roundTripByteExact": true' | head -1)"

say "== D2: base58 f64 argument (v0.4.4 died with readDoubleLE is not a function)"
OUT=$(npx sememe decode opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb \
  NGerSciS12QSNBFSYtf2iJ --store "$STORE" 2>&1)
printf '%s' "$OUT" | grep -q 'readDoubleLE' && { say "  FAIL readDoubleLE failure"; FAIL=1; } || say "  OK   no readDoubleLE failure"
check "price is 1.5" '"price": 1.5' "$(printf '%s' "$OUT" | grep -o '"price": 1.5' | head -1)"

say "== D3: base58 bytes argument as base64 (v0.4.4 printed a comma list)"
OUT=$(npx sememe decode FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr \
  9uUUHGhBqHoci5ACKsdJiJmXU --store "$STORE" 2>&1)
check "data is base64 3q2+7w==" '"data": "3q2+7w=="' \
  "$(printf '%s' "$OUT" | grep -o '"data": "[^"]*"' | head -1)"
printf '%s' "$OUT" | grep -qE '"data": "[0-9]+,' && { say "  FAIL comma list"; FAIL=1; } || say "  OK   no comma list"

say "== equivalence: base58 output is byte-identical to hex output"
eq() { # eq <program> <base58> <hex>
  if diff <(npx sememe decode "$1" "$2" --store "$STORE") \
          <(npx sememe decode "$1" "$3" --store "$STORE") >/dev/null
  then say "  OK   $4"
  else say "  FAIL $4"; FAIL=1; fi
}
eq opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb NGerSciS12QSNBFSYtf2iJ \
   ac3f65538d4cc7d8000000000000f83f "openbook f64 identical"
eq FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr 9uUUHGhBqHoci5ACKsdJiJmXU \
   d6b0bcf4cb3be6cf010004000000deadbeef "farms bytes identical"

say ""
[ "$FAIL" -eq 0 ] && say "JOURNEY PASS" || say "JOURNEY FAIL"
exit "$FAIL"
