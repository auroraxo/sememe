import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pinnedSignaturesOf, hasPinnedSignatures } from '../tools/lib/pinned.mjs';

// The pinned list is what makes a harvest re-derivable. These tests pin the
// two ways it can go wrong — resolving to the WRONG set, and resolving to
// NOTHING while looking successful.

const FIXTURE = new URL('./fixtures/harvest-whirlpool-2026-10-28.json', import.meta.url);

test('the committed fixture pins exactly the transactions it carries', async () => {
  const document = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const pinned = pinnedSignaturesOf(document);

  assert.equal(pinned.length, document.transactions.length);
  const unique = new Set(pinned.map((entry) => entry.signature));
  assert.equal(unique.size, pinned.length, 'pinned signatures must be unique');

  // Every pinned signature must belong to a transaction of the fixture, and
  // every transaction must be pinned: a partial list would re-derive a
  // smaller sample that still looks like a complete run.
  const carried = new Set(document.transactions.map((entry) => entry.signature));
  for (const entry of pinned) assert.ok(carried.has(entry.signature), `pinned ${entry.signature} is not in the fixture`);
  for (const entry of document.transactions) assert.ok(unique.has(entry.signature), `transaction ${entry.signature} is not pinned`);
});

test('the pinned list carries the slot of each transaction', async () => {
  const document = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const pinned = pinnedSignaturesOf(document);
  const slots = new Map(document.transactions.map((entry) => [entry.signature, entry.slot]));
  for (const entry of pinned) {
    assert.equal(entry.slot, slots.get(entry.signature));
  }
});

test('transaction records win over a declared signature list', () => {
  // Measured on this repo's own harvest: the getSignaturesForAddress page and
  // the payload set are different sets (Whirlpool is mostly CPI-invoked, and a
  // CPI-only transaction never appears in the callee's signature page). The
  // transactions name the payload set exactly, so they must win.
  const document = {
    signatures: [{ signature: 'page-only', slot: 1 }],
    transactions: [{ signature: 'payload-tx', slot: 42 }],
  };
  const pinned = pinnedSignaturesOf(document);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].signature, 'payload-tx');
  assert.equal(pinned[0].slot, 42);
});

test('a declared signature list is used when the document carries no transactions', () => {
  const document = { signatures: [{ signature: 'a', slot: 1 }, { signature: 'b', slot: 2 }] };
  assert.deepEqual(pinnedSignaturesOf(document).map((entry) => entry.signature), ['a', 'b']);

  const strings = { signatures: ['a', 'b'] };
  assert.deepEqual(pinnedSignaturesOf(strings).map((entry) => entry.signature), ['a', 'b']);
});

test('a harvest that pins nothing is refused instead of resolving to empty', () => {
  // The failure this guards: a harvest document that carries no pinnable
  // signature re-derives to zero transactions, exits 0, and looks like a
  // successful measurement of nothing.
  assert.throws(() => pinnedSignaturesOf({ transactions: [] }), /pins no signatures/);
  assert.throws(() => pinnedSignaturesOf({}), /pins no signatures/);
  assert.throws(() => pinnedSignaturesOf({ signatures: [] }), /pins no signatures/);
  assert.throws(() => pinnedSignaturesOf({ transactions: [{ slot: 1 }] }), /pins no signatures/);
  assert.throws(() => pinnedSignaturesOf(null), /not an object/);
  assert.throws(() => pinnedSignaturesOf('nonsense'), /not an object/);

  assert.equal(hasPinnedSignatures({ transactions: [] }), false);
  assert.equal(hasPinnedSignatures({ transactions: [{ signature: 'x' }] }), true);
});
