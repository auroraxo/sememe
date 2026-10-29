// slotRange must survive a harvest-scale array.
//
// Regression: tools/harvest.mjs computed the range with Math.min(...slots) and
// crashed with RangeError: Maximum call stack size exceeded AFTER collecting
// every block — the RPC work was already paid for and the file was never
// written. A large Kamino Lend harvest (2026-10-29) hit exactly that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { slotRange } from '../tools/lib/slot-range.mjs';

test('slotRange reduces a harvest-scale array without the call stack', () => {
  // 400,000 slots: far past the ~125k argument limit Math.min(...) accepts.
  const slots = new Array(400_000);
  let expectedOldest = Infinity;
  let expectedNewest = -Infinity;
  for (let i = 0; i < slots.length; i++) {
    slots[i] = 462_000_000 + ((i * 7919) % 1_000_000);
    expectedOldest = Math.min(expectedOldest, slots[i]);
    expectedNewest = Math.max(expectedNewest, slots[i]);
  }
  const range = slotRange(slots);
  assert.equal(range.oldest, expectedOldest);
  assert.equal(range.newest, expectedNewest);
});

test('slotRange ignores non-integer entries instead of producing NaN', () => {
  assert.deepEqual(slotRange([5, null, 3, undefined, 9]), { oldest: 3, newest: 9 });
  assert.deepEqual(slotRange(['7']), null, 'no safe integer means no range');
});

test('slotRange returns null for an empty harvest', () => {
  assert.equal(slotRange([]), null);
  assert.equal(slotRange(undefined), null);
  assert.equal(slotRange([null, undefined]), null);
});
