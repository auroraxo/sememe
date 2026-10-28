import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compareReDerived, isCompleteReproduction } from '../tools/lib/rederive-verify.mjs';

// A re-derivation over a public RPC is rate-limited, so it can come back
// partial. The point of these tests: "reproduced" and "partially fetched" must
// not be confusable, and a partial fetch must be reported as a failure rather
// than as a successful run.

const FIXTURE = new URL('./fixtures/harvest-whirlpool-2026-10-28.json', import.meta.url);

test('a re-derivation that reproduces every payload is complete', async () => {
  const document = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const result = compareReDerived(document, document);
  assert.equal(result.missing.length, 0);
  assert.equal(result.mismatched.length, 0);
  assert.equal(result.payloadSetsChecked, document.transactions.length);
  assert.equal(result.payloadSetsMatched, document.transactions.length);
  assert.equal(result.payloadBytesMatched, true);
  assert.equal(isCompleteReproduction(result), true);
});

test('a rate-limited fetch is not a reproduction', async () => {
  const document = JSON.parse(await readFile(FIXTURE, 'utf8'));
  // Three transactions never came back — exactly the shape of a public RPC
  // answering 429 until the harvester gives up.
  const partial = {
    transactions: document.transactions.map((entry, index) => (
      index < 3 ? { signature: entry.signature, missing: true, payloads: [] } : entry
    )),
  };
  const result = compareReDerived(document, partial);
  assert.equal(result.missing.length, 3);
  assert.equal(result.fetched, document.transactions.length - 3);
  assert.equal(result.payloadBytesMatched, false, 'a partial fetch must not claim byte-exactness');
  assert.equal(isCompleteReproduction(result), false);
});

test('a changed payload byte is reported, not accepted', async () => {
  const document = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const tampered = JSON.parse(JSON.stringify(document));
  const payload = tampered.transactions[0].payloads[0];
  payload.dataHex = `ff${payload.dataHex.slice(2)}`;
  const result = compareReDerived(document, tampered);
  assert.equal(result.mismatched.length, 1);
  assert.equal(result.payloadSetsMatched, document.transactions.length - 1);
  assert.match(result.mismatched[0].firstDifference, /dataHex/);
  assert.equal(result.payloadBytesMatched, false);
  assert.equal(isCompleteReproduction(result), false);
});

test('a dropped payload inside a transaction is reported', async () => {
  const document = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const tampered = JSON.parse(JSON.stringify(document));
  tampered.transactions[0].payloads = tampered.transactions[0].payloads.slice(0, -1);
  const result = compareReDerived(document, tampered);
  assert.equal(result.mismatched.length, 1);
  assert.match(result.mismatched[0].firstDifference, /payload count/);
});

test('an empty re-derivation compares to nothing at all', async () => {
  const document = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const result = compareReDerived(document, { transactions: [] });
  assert.equal(result.fetched, 0);
  assert.equal(result.missing.length, document.transactions.length);
  assert.equal(result.payloadBytesMatched, false, 'zero fetched payloads must not count as byte-exact');
  assert.equal(isCompleteReproduction(result), false);
});
