#!/usr/bin/env bash
# tools/mutation-ladder-hadron.sh — does the HADRo acquisition's guard set
# actually BITE? Each mutation breaks ONE mechanism and the ladder must
# CATCH it; the control (no mutation) must stay green, and the working tree
# must come back byte-identical afterwards.
#
# WHAT IS MUTATED, AND WHY EACH ONE MATTERS:
#
#   M1  the vendored bytes change (one byte in the IDL) -> the sha256 pin must
#       refuse. A pin that does not bite adopts unreviewed bytes.
#   M2  the vendored file is missing -> the loader must refuse by name. A
#       loader that reads an empty path would "adopt" nothing and call it
#       success.
#   M3  the vendored file declares another program -> the address check must
#       refuse. Without it, a copy for program A could be adopted as
#       program B — the re-labelling hazard src/adopt.mjs names.
#   M4  the vendored copy loses one `sequence:u64` tail -> the CLAIM check
#       must refuse, even though the bytes hash correctly against a pin that
#       was updated with them. This is the mutation a pure hash pin cannot
#       catch, and the reason the loader checks the claim as well.
#   M5  the origin label exceeds adopt's 64-character cap -> the recorded
#       origin must still carry the WHOLE 40-hex commit. Truncating a commit
#       to 35 hex characters is not a commit.
#
# EXIT: 0 when every mutation is caught and the control is green, 1 when a
# mutation survives. The tree is restored on every exit path.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

COMMIT="$(sed -n "s/.*commit: '\([0-9a-f]\{40\}\)'.*/\1/p" src/hadron.mjs | head -1)"
VENDOR="vendor/hadron/$COMMIT"
TEST="test/hadron-adoption.test.mjs"
WORK="$(mktemp -d)"
BACKUP="$WORK/hadron.json"
SRC_BACKUP="$WORK/hadron.mjs"
cp "$VENDOR/hadron.json" "$BACKUP"
# src/hadron.mjs is a NEW, untracked file, so `git checkout --` cannot
# restore it: M5 edits it and the control would then run against the MUTATED
# module. Back it up by copying, like the vendor file.
cp src/hadron.mjs "$SRC_BACKUP"

restore() {
  cp "$BACKUP" "$VENDOR/hadron.json"
  cp "$SRC_BACKUP" src/hadron.mjs
  rm -rf "$WORK"
}
trap restore EXIT

caught=0
survived=0

run_test() {
  node --test "$TEST" 2>&1 | grep -E '^(ℹ pass|ℹ fail)' | tr '\n' ' '
}

expect_red() {
  local label="$1"
  local out
  out="$(run_test)"
  local pass fail
  pass="$(echo "$out" | sed -n 's/.*ℹ pass \([0-9]*\).*/\1/p')"
  fail="$(echo "$out" | sed -n 's/.*ℹ fail \([0-9]*\).*/\1/p')"
  if [ "${fail:-0}" -ge 1 ]; then
    echo "  CAUGHT  $label (pass=$pass fail=$fail)"
    caught=$((caught + 1))
  else
    echo "  SURVIVED $label (pass=$pass fail=$fail) — the guard does not bite"
    survived=$((survived + 1))
  fi
}

expect_green() {
  local label="$1"
  local out
  out="$(run_test)"
  local pass fail
  pass="$(echo "$out" | sed -n 's/.*ℹ pass \([0-9]*\).*/\1/p')"
  fail="$(echo "$out" | sed -n 's/.*ℹ fail \([0-9]*\).*/\1/p')"
  if [ "${fail:-0}" -eq 0 ] && [ "${pass:-0}" -ge 9 ]; then
    echo "  GREEN   $label (pass=$pass fail=$fail)"
  else
    echo "  BROKE   $label (pass=$pass fail=$fail) — the control must be green"
    survived=$((survived + 1))
  fi
}

echo "control: the unmutated tree must be green"
expect_green "control"

echo "M1 the vendored bytes change -> the sha256 pin must refuse"
python3 - "$VENDOR/hadron.json" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
open(p, 'w').write(s.replace('"name"', '"namE"', 1))
PY
expect_red "M1 tampered vendored bytes"

echo "M2 the vendored file is missing -> the loader must refuse by name"
mv "$VENDOR/hadron.json" "$WORK/hadron.json.moved"
expect_red "M2 missing vendor file"

echo "M3 the vendored file declares another program -> the address check must refuse"
cp "$BACKUP" "$VENDOR/hadron.json"
cp "$SRC_BACKUP" src/hadron.mjs
python3 - "$VENDOR/hadron.json" "$WORK" <<'PY'
import json, sys
p, work = sys.argv[1], sys.argv[2]
idl = json.load(open(p))
idl['address'] = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
raw = json.dumps(idl).encode()
open(p, 'wb').write(raw)
# the pin is updated WITH the tampered bytes, so only the CLAIM check can
# catch this one — a hash pin alone would wave it through.
import hashlib, re
digest = hashlib.sha256(raw).hexdigest()
src = open('src/hadron.mjs').read()
src = src.replace("219f44fb63729232b3685fbde49a817b0c8321a0203dcca68c88370fbed1279e", digest)
open('src/hadron.mjs', 'w').write(src)
PY
expect_red "M3 re-labelled address (pin updated with the tampered bytes)"

echo "M4 the copy loses one sequence:u64 tail -> the CLAIM check must refuse"
cp "$BACKUP" "$VENDOR/hadron.json"
cp "$SRC_BACKUP" src/hadron.mjs
python3 - "$VENDOR/hadron.json" <<'PY'
import json, sys
p = sys.argv[1]
idl = json.load(open(p))
for ix in idl['instructions']:
    if ix['name'] == 'setCurve':
        ix['args'].pop()
raw = json.dumps(idl).encode()
open(p, 'wb').write(raw)
import hashlib
digest = hashlib.sha256(raw).hexdigest()
src = open('src/hadron.mjs').read()
src = src.replace("219f44fb63729232b3685fbde49a817b0c8321a0203dcca68c88370fbed1279e", digest)
open('src/hadron.mjs', 'w').write(src)
PY
expect_red "M4 dropped sequence:u64 tail (pin updated with the tampered bytes)"

echo "M5 the origin label exceeds adopt's 64-character cap -> the commit must survive whole"
cp "$BACKUP" "$VENDOR/hadron.json"
cp "$SRC_BACKUP" src/hadron.mjs
python3 - <<'PY'
src = open('src/hadron.mjs').read()
src = src.replace(
  "return `hadron-tx-verifier@${HADRON_PIN.commit}`;",
  "return `github.com/Hadron-Fi/hadron-tx-verifier@${HADRON_PIN.commit}:idl/hadron.json`;",
)
open('src/hadron.mjs', 'w').write(src)
PY
expect_red "M5 over-long origin label truncates the commit"

echo "restore and confirm the tree is green again"
cp "$BACKUP" "$VENDOR/hadron.json"
cp "$SRC_BACKUP" src/hadron.mjs
expect_green "restored control"

echo
echo "mutations caught: $caught   survived: $survived"
if [ "$survived" -ne 0 ]; then
  echo "LADDER FAILED — a guard does not bite"
  exit 1
fi
echo "LADDER OK — every mutation is caught and the control is green"
