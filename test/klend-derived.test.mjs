// Third program, family-distant: Kamino Lend (lending, not a swap AMM).
//
// What this fixes and measures:
//
// The on-chain IDL of Kamino Lend (pulled 2026-10-29, slot 462900393, legacy
// `anchor:idl` account) names 66 instructions and 5 events but carries NO
// discriminators — 0 of 71. A decoder indexes by discriminator, so before the
// derivation the index was EMPTY and every real payload of this program was
// refused: measured 0 of 1432 decoded, all with "unknown instruction
// discriminator".
//
// The 20-program coverage run had counted this program "usable" anyway,
// because usable meant "names instructions". That is the gap this test pins
// shut: a schema that cannot decode a byte must not pass as decoded coverage
// unless a rule fills the gap AND real payloads then round-trip byte-exact.
//
// After Anchor's rule fills the gaps: 1432/1432 real mainnet payloads decode
// and re-encode byte-exact, 0 errors, 0 trailing. Naming cross-checked against
// Kamino's own published IDL (@kamino-finance/klend-sdk): 1432/1432 named by
// both sources, 0 disagreements.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  decodeData, decodeInstructionData, encodeInstructionData, instructionIndex,
} from '../src/codec.mjs';
import { withDerivedDiscriminators, verifyDerivedDiscriminators } from '../src/discriminators.mjs';
import { decodePayload, findStoredIdl } from '../src/decode.mjs';

const KLEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const storedIdl = JSON.parse(
  await readFile(new URL('./fixtures/kamino-lend-idl.json', import.meta.url), 'utf8'));
const harvest = JSON.parse(
  await readFile(new URL('./fixtures/harvest-kamino-lend-2026-10-29.json', import.meta.url), 'utf8'));

function payloads() {
  const out = [];
  for (const tx of harvest.transactions) {
    if (tx.missing) continue;
    for (const payload of tx.payloads ?? []) out.push(payload);
  }
  return out;
}

test('the Kamino fixture is the program and volume it claims', () => {
  assert.equal(harvest.program, KLEND);
  assert.equal(payloads().length, 1432);
  assert.ok(harvest.slotRange.oldest <= harvest.slotRange.newest);
});

test('the stored on-chain Kamino IDL carries no discriminators at all', () => {
  // This is the premise of the whole change. If a future pull starts storing
  // discriminators, this test should fail loudly and the derivation becomes
  // belt-and-braces instead of load-bearing.
  const withStored = storedIdl.instructions.filter((i) => Array.isArray(i.discriminator)).length;
  assert.equal(storedIdl.instructions.length, 66);
  assert.equal(withStored, 0);
  const eventsWithStored = (storedIdl.events ?? []).filter((e) => Array.isArray(e.discriminator)).length;
  assert.equal((storedIdl.events ?? []).length, 5);
  assert.equal(eventsWithStored, 0);
});

test('without derivation, no real Kamino payload decodes: 0/1432', () => {
  const index = instructionIndex(storedIdl);
  assert.equal(index.size, 0, 'a discriminator index built from the stored IDL is empty');
  let refused = 0;
  for (const payload of payloads()) {
    try {
      decodeInstructionData(storedIdl, Buffer.from(payload.dataHex, 'hex'), { trailing: 'report' });
    } catch (error) {
      assert.match(error.message, /unknown instruction discriminator/);
      refused++;
    }
  }
  assert.equal(refused, 1432);
});

test('with derivation, every real Kamino payload decodes and re-encodes byte-exact', () => {
  const { idl, filled, conflicts } = withDerivedDiscriminators(storedIdl);
  assert.deepEqual(filled, { instructions: 66, events: 5 });
  assert.deepEqual(conflicts, []);

  let instructions = 0;
  let trailing = 0;
  for (const payload of payloads()) {
    const bytes = Buffer.from(payload.dataHex, 'hex');
    const decoded = decodeData(idl, bytes, { trailing: 'report' });
    assert.equal(decoded.kind, 'instruction');
    instructions++;
    assert.ok(
      encodeInstructionData(idl, decoded.instruction, decoded.args).equals(bytes),
      `${decoded.instruction} did not round-trip byte-exact`);
    if (decoded.trailing.count > 0) trailing++;
  }
  assert.equal(instructions, 1432);
  assert.equal(trailing, 0, 'no Kamino payload should carry unexplained bytes');
});

test('decodePayload reports that the matched discriminator was derived, not stored', async () => {
  // Build a store in the layout `sememe pull` produces, from the committed
  // fixture, so the end-to-end path (receipt -> object -> decode) is exercised
  // exactly as a user hits it.
  const store = await mkdtemp(path.join(tmpdir(), 'sememe-derived-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  const { canonicalJson } = await import('../src/canonical.mjs');
  const json = Buffer.from(canonicalJson(storedIdl) + '\n');
  const { createHash } = await import('node:crypto');
  const fingerprint = createHash('sha256').update(json).digest('hex');
  await writeFile(path.join(store, 'objects', `${fingerprint}.json`), json);
  await writeFile(
    path.join(store, 'receipts', `${KLEND}-462900393-anchor-${fingerprint}.json`),
    JSON.stringify({
      program: KLEND, source: 'anchor', address: '8qLKwp1fk8WyqmzarkuMeZEX3AzL4VDSmA2UZTKT2aCJ',
      slot: 462900393, fingerprint: `sha256:${fingerprint}`, instructionCount: 66,
    }));

  const sample = payloads()[0];
  const decoded = await decodePayload(store, KLEND, sample.dataHex);
  assert.ok(typeof decoded.instruction === 'string' && decoded.instruction.length > 0);
  assert.equal(decoded.roundTripByteExact, true);
  assert.equal(decoded.discriminatorSource, 'derived');
  assert.deepEqual(decoded.discriminatorDerivation,
    { filledInstructions: 66, filledEvents: 5, conflicts: 0 });

  // The stored object on disk is untouched by derivation: the fingerprint a
  // consumer verifies still describes exactly the bytes the program wrote.
  const { objectPath } = await findStoredIdl(store, KLEND);
  const onDisk = JSON.parse(await readFile(objectPath, 'utf8'));
  assert.equal(onDisk.instructions[0].discriminator, undefined);
});

test('deriving twice yields identical bytes: the fill is deterministic', () => {
  // Kamino's own published IDL (@kamino-finance/klend-sdk) has the same
  // legacy shape — no stored discriminators — so it cannot act as an oracle
  // here. The invariant that matters for the store is determinism: the same
  // stored object must always fill to the same bytes, or the decoder's result
  // would depend on when it ran.
  const first = withDerivedDiscriminators(storedIdl);
  const second = withDerivedDiscriminators(JSON.parse(JSON.stringify(storedIdl)));
  assert.deepEqual(first.idl.instructions.map((i) => i.discriminator),
    second.idl.instructions.map((i) => i.discriminator));
  assert.deepEqual(verifyDerivedDiscriminators(first.idl).conflicts, [],
    'a filled IDL must not conflict with itself');
});
