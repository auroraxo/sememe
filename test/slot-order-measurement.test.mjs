// The slot-order measurement: one store, one answer across digit lengths.
//
// This file pins the two committed artifacts of tools/measure-slot-order.mjs:
//
//   research/slot-order-2026-11-07-before.json  the PUBLISHED v0.4.9 install
//       (github:auroraxo/sememe#v0.4.9 in an empty app, no clone)
//   research/slot-order-2026-11-07.json          the FIXED tree
//   research/slot-order-2026-11-07-v0.4.10.json  the PUBLISHED v0.4.10 tag
//       (github:auroraxo/sememe#v0.4.10 in an empty app, no clone)
//
// WHAT WAS MEASURED — a store whose two ON-CHAIN receipts of one program carry
// slot strings of different digit length (99999999 older, 123456789 newer):
//
//   BEFORE (published v0.4.9): plain decode answered slot 99999999 while
//   `decode --union` answered 123456789 and `lock` pinned 99999999 — two
//   receipts named as "the newest" by three surfaces of one binary. The union
//   path sorts on-chain receipts numerically; the plain reader and the lock
//   sorted by FILENAME, and a decimal string sorts by its digits.
//
//   AFTER (this tree): every surface names slot 123456789, they agree, and
//   verify is clean over the store it just locked. The equal-length control
//   (what a fresh `pull` writes today) is green on BOTH sides — the defect is
//   specific to stores whose slot strings differ in length, not a general
//   breakage.
//
// The suite's job is to keep the fixed tree fixed and the before-artifact
// honest: a hand-edited "before" that said the published install was clean
// would make this file prove nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm as fsRm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-slot-order.mjs');
const BEFORE = path.join(ROOT, 'research', 'slot-order-2026-11-07-before.json');
const AFTER = path.join(ROOT, 'research', 'slot-order-2026-11-07.json');
// The RELEASE artifact: the fix is only real once a stranger can install it.
// Measured on the published v0.4.10 tag installed into an empty app, so the
// bytes measured are the bytes `npm install github:auroraxo/sememe#v0.4.10`
// hands over — not this working tree.
const TAG = path.join(ROOT, 'research', 'slot-order-2026-11-07-v0.4.10.json');

const before = JSON.parse(await readFile(BEFORE, 'utf8'));
const after = JSON.parse(await readFile(AFTER, 'utf8'));
const tag = JSON.parse(await readFile(TAG, 'utf8'));

const NEW_SLOT = 123456789;
const OLD_SLOT = 99999999;
const CTL_NEW_SLOT = 465713413;

test('the BEFORE artifact records the defect on the PUBLISHED v0.4.9 install', () => {
  assert.equal(before.binary.tag, 'v0.4.9',
    'the before-artifact must be measured on the published tag, not on this tree');
  assert.equal(before.verdict.ok, false,
    'v0.4.9 violated the contract — if this says clean, the measurement is wrong');
  assert.ok(before.verdict.violations.length >= 3,
    `the defect must be recorded violation by violation, got ${JSON.stringify(before.verdict.violations)}`);

  // The headline: three surfaces, two different receipts — and the plain
  // decode does not merely answer differently, it REFUSES the payload the
  // union path decoded one line later. Measured on the published v0.4.9:
  // plain decode exited 1 (the older copy it picked does not know sell_v3),
  // union decode exited 0 with sell_v3 from the newer copy.
  const t1 = before.mixedDigitSlots.t1;
  assert.equal(t1.plainExit, 1,
    'v0.4.9 plain decode refused the payload — it read the OLDER copy');
  assert.equal(t1.unionExit, 0, 'v0.4.9 union decode answered the payload from the NEWER copy');
  assert.equal(t1.unionSlot, NEW_SLOT,
    'v0.4.9 union decode answered the NUMERICALLY NEWEST receipt');
  assert.equal(t1.unionInstruction, 'sell_v3');
  assert.equal(t1.sameReceipt, false,
    'one store, two answers — the defect this fix names');

  const t2 = before.mixedDigitSlots.t2;
  assert.equal(t2.lockedSlot, OLD_SLOT,
    'v0.4.9 pinned the older receipt while the union path read the newer one');
  assert.notEqual(t2.lockedFingerprint, t1.unionFingerprint,
    'the lock pinned a different receipt than the union decode read');

  // The control was green BEFORE the fix too: the defect is specific to
  // stores whose slot strings differ in length, not a general breakage.
  const t4 = before.controlEqualDigitSlots;
  assert.equal(t4.plainExit, 0);
  assert.equal(t4.sameReceipt, true);
  assert.equal(t4.plainSlot, CTL_NEW_SLOT);
  assert.equal(t4.lockedSlot, CTL_NEW_SLOT);
  assert.equal(t4.verifyExit, 0);
});

test('the AFTER artifact is the one the tool produces right now (no hand-edited numbers)', async () => {
  const fresh = path.join(ROOT, 'research', '.slot-order-fresh.json');
  try {
    execFileSync(process.execPath, [TOOL, fresh], { cwd: ROOT, stdio: 'pipe' });
    const computed = JSON.parse(await readFile(fresh, 'utf8'));
    delete computed.generatedAt;
    delete after.generatedAt;
    assert.deepEqual(computed, after,
      'the committed after-artifact must be exactly what the tool measures now');
  } finally {
    await fsRm(fresh, { force: true });
  }
});

test('the fixed tree satisfies the whole contract, control included', () => {
  assert.equal(after.verdict.ok, true,
    `the fixed tree violated the contract: ${JSON.stringify(after.verdict.violations)}`);

  const t1 = after.mixedDigitSlots.t1;
  assert.equal(t1.plainSlot, NEW_SLOT, 'the plain reader picks the numeric newest');
  assert.equal(t1.unionSlot, NEW_SLOT, 'the union path keeps picking the numeric newest');
  assert.equal(t1.sameReceipt, true, 'one store, one answer — whatever flag the caller passes');
  assert.equal(t1.plainFingerprint, t1.unionFingerprint);
  assert.equal(t1.plainInstruction, 'sell_v3');
  assert.equal(t1.unionInstruction, 'sell_v3');

  const t2 = after.mixedDigitSlots.t2;
  assert.equal(t2.lockExit, 0);
  assert.equal(t2.lockedSlot, NEW_SLOT, 'the lock pins the receipt the decoders read');
  assert.equal(t2.lockedFingerprint, t1.plainFingerprint);

  const t3 = after.mixedDigitSlots.t3;
  assert.equal(t3.verifyExit, 0, 'verify must be clean over the store it just locked');

  const t4 = after.controlEqualDigitSlots;
  assert.equal(t4.plainSlot, CTL_NEW_SLOT);
  assert.equal(t4.lockedSlot, CTL_NEW_SLOT);
  assert.equal(t4.verifyExit, 0, 'the fix must not turn an ordinary store red');
});

test('the fix is visible in the measurement, not only in the unit tests', () => {
  const b = before.mixedDigitSlots;
  const a = after.mixedDigitSlots;
  assert.notEqual(b.t1.plainSlot, a.t1.plainSlot, 'the plain reader must move to the newest slot');
  assert.notEqual(b.t1.sameReceipt, a.t1.sameReceipt, 'the two answers must agree now');
  assert.notEqual(b.t2.lockedSlot, a.t2.lockedSlot, 'the lock must pin the newest slot now');
  // And the control must NOT move — the fix changes the defective case only.
  assert.equal(before.controlEqualDigitSlots.plainSlot, after.controlEqualDigitSlots.plainSlot,
    'the control must be untouched by the fix');
  assert.equal(before.controlEqualDigitSlots.verifyExit, after.controlEqualDigitSlots.verifyExit);
});

test('the PUBLISHED v0.4.10 tag satisfies the whole contract — the fix a stranger gets', () => {
  assert.equal(tag.binary.tag, 'v0.4.10',
    'the release artifact must be measured on the published tag, not on this tree');
  assert.equal(tag.verdict.ok, true,
    `the published v0.4.10 violated the contract: ${JSON.stringify(tag.verdict.violations)}`);

  // Same numbers as the tree, measured on the installed bytes: the tag
  // carries the fix, it is not the tree that carries it.
  const t1 = tag.mixedDigitSlots.t1;
  assert.equal(t1.plainExit, 0);
  assert.equal(t1.plainSlot, NEW_SLOT);
  assert.equal(t1.unionSlot, NEW_SLOT);
  assert.equal(t1.sameReceipt, true);
  assert.equal(t1.plainInstruction, 'sell_v3');
  assert.equal(t1.unionInstruction, 'sell_v3');

  const t2 = tag.mixedDigitSlots.t2;
  assert.equal(t2.lockExit, 0);
  assert.equal(t2.lockedSlot, NEW_SLOT);
  assert.equal(t2.lockedFingerprint, t1.plainFingerprint);

  const t3 = tag.mixedDigitSlots.t3;
  assert.equal(t3.verifyExit, 0, 'verify must be clean over the store it just locked');

  const t4 = tag.controlEqualDigitSlots;
  assert.equal(t4.plainSlot, CTL_NEW_SLOT);
  assert.equal(t4.lockedSlot, CTL_NEW_SLOT);
  assert.equal(t4.verifyExit, 0);

  // And the tag must NOT reproduce the defect the before-artifact records.
  assert.notEqual(tag.mixedDigitSlots.t1.plainSlot, before.mixedDigitSlots.t1.plainSlot,
    'the published tag must not read the older receipt the v0.4.9 install read');
  assert.equal(tag.mixedDigitSlots.t1.sameReceipt, true);
  assert.equal(tag.mixedDigitSlots.t2.lockedSlot, NEW_SLOT,
    'the published tag pins the newest receipt, not the one v0.4.9 pinned');
  assert.notEqual(tag.mixedDigitSlots.t2.lockedSlot, before.mixedDigitSlots.t2.lockedSlot,
    'the published tag must pin a different receipt than v0.4.9 did');
});
