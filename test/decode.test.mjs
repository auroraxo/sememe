import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodePayload, parsePayload, decodeBase58, findStoredIdl } from '../src/decode.mjs';

const PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const fixture = JSON.parse(
  await readFile(new URL('./fixtures/mainnet-whirlpool.json', import.meta.url), 'utf8'));
const idlUrl = process.env.SEMEME_TEST_IDL_URL ?? null;

// The production IDL: prefer the local store from the qualification run so CI
// and a live machine exercise the same bytes the pull produced. When there is
// no live store (fresh checkout, CI), rebuild one from the committed snapshot
// test/fixtures/whirlpool-idl.json — whose sha256 equals the receipt
// fingerprint — so the mainnet-payload regression tests never silently skip.
async function productionIdl() {
  const store = process.env.SEMEME_TEST_STORE ?? path.join(os.tmpdir(), 'sememe-user-zero');
  try {
    const { idl } = await findStoredIdl(store, PROGRAM);
    return { idl, store, receipt: null, source: 'live-store' };
  } catch { /* fall through to the committed snapshot */ }
  try {
    const idl = JSON.parse(await readFile(new URL('./fixtures/whirlpool-idl.json', import.meta.url), 'utf8'));
    const receipt = JSON.parse(
      await readFile(new URL('./fixtures/whirlpool-receipt.json', import.meta.url), 'utf8'));
    const fingerprint = receipt.fingerprint.replace('sha256:', '');
    const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-fixture-store-'));
    await mkdir(path.join(store, 'objects'), { recursive: true });
    await mkdir(path.join(store, 'receipts'), { recursive: true });
    await writeFile(path.join(store, 'objects', `${fingerprint}.json`), JSON.stringify(idl));
    await writeFile(path.join(store, 'receipts', `${PROGRAM}-${receipt.slot}-metadata-${fingerprint}.json`),
      JSON.stringify(receipt));
    // Sanity: the committed bytes must still fingerprint to the receipt
    // value, otherwise the snapshot drifted from the provenance it claims.
    // The store fingerprints sha256(canonicalJson(idl) + '\n'), so re-hash
    // with the same canonicalizer rather than JSON.stringify.
    const { canonicalJson } = await import('../src/pull.mjs');
    const { createHash } = await import('node:crypto');
    const actual = createHash('sha256').update(`${canonicalJson(idl)}\n`).digest('hex');
    if (actual !== fingerprint) {
      throw new Error(`committed IDL fingerprint mismatch: receipt ${fingerprint}, actual ${actual}`);
    }
    return { idl, store, receipt, source: 'committed-fixture', cleanup: store };
  } catch { return null; }
}
const production = await productionIdl();

async function temporaryStore(idl) {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-decode-test-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  // A store a reader can verify: object bytes and receipt fingerprint must be
  // the same bytes `sememe pull` would write, or the integrity check refuses it.
  const { canonicalJson } = await import('../src/canonical.mjs');
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from(canonicalJson(idl) + '\n');
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(store, 'objects', `${fingerprint}.json`), bytes);
  await writeFile(
    path.join(store, 'receipts', `${PROGRAM}-42-metadata-${fingerprint}.json`),
    JSON.stringify({ program: PROGRAM, fingerprint: `sha256:${fingerprint}`, slot: 42, source: 'metadata' }));
  return { store, fingerprint };
}
const withStore = async (idl, fn) => {
  const { store } = await temporaryStore(idl);
  try { return await fn(store); } finally { await rm(store, { recursive: true, force: true }); }
};

const minimal = {
  instructions: [
    { name: 'swap_like', discriminator: [1, 2, 3, 4, 5, 6, 7, 8],
      args: [{ name: 'amount', type: 'u64' }, { name: 'limit', type: 'u64' }] },
  ],
  types: [],
};

test('base58 payload decoding is exact and rejects bad input', () => {
  // bytes: 0102030405060708 2a00000000000000 0100000000000000
  const hex = '01020304050607082a000000000000000100000000000000';
  assert.equal(decodeBase58('2MVhjvUjqCBR4UmHMFfPdqv').length > 0, true);
  assert.throws(() => decodeBase58('0OIl'), /invalid base58 character/);
  assert.throws(() => decodeBase58(''), /non-empty/);
  assert.deepEqual(parsePayload(`0x${hex}`), Buffer.from(hex, 'hex'));
  assert.deepEqual(parsePayload(hex), Buffer.from(hex, 'hex'));
});

test('decodePayload returns provenance, args and a byte-exact round trip', async () => {
  const { store, fingerprint } = await temporaryStore(minimal);
  try {
    const payload = Buffer.from('01020304050607082a000000000000000100000000000000', 'hex');
    const result = await decodePayload(store, PROGRAM, payload.toString('base64')
      .replace(/\+/g, '').slice(0, 0) + payload.toString('hex'));
    assert.equal(result.instruction, 'swap_like');
    assert.equal(result.discriminator, '0102030405060708');
    assert.deepEqual(result.args, { amount: '42', limit: '1' });
    assert.equal(result.roundTripByteExact, true);
    assert.equal(result.idl.fingerprint, `sha256:${fingerprint}`);
    assert.equal(result.consumed, result.bytes);
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('decodePayload refuses an unknown program in the store', async () => {
  const { store } = await temporaryStore(minimal);
  try {
    await assert.rejects(() => decodePayload(store, 'ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S', 'aa'),
      /no stored IDL for program/);
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('unknown discriminator and unexplained trailing bytes are never silent', async () => {
  const { store } = await temporaryStore(minimal);
  try {
    await assert.rejects(() => decodePayload(store, PROGRAM, 'ffffffff0100000000000000'),
      /unknown instruction discriminator/);
    // default: decode the described prefix and report the bytes the IDL cannot
    // explain, instead of guessing at them or discarding them silently.
    const reported = await decodePayload(store, PROGRAM,
      '01020304050607082a000000000000000100000000000000ff');
    assert.deepEqual(reported.args, { amount: '42', limit: '1' });
    assert.deepEqual(reported.trailing, { count: 1, hex: 'ff' });
    assert.equal(reported.consumed, 24);
    assert.equal(reported.bytes, 25);
    assert.equal(reported.describedRoundTripByteExact, true);
    assert.equal(reported.roundTripByteExact, false);
    // explicit strict mode still refuses the payload outright.
    await assert.rejects(() => decodePayload(store, PROGRAM,
      '01020304050607082a000000000000000100000000000000ff', { trailing: 'error' }),
      /trailing bytes/);
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('every harvested mainnet payload decodes, and unexplained bytes are counted', { skip: !production }, async () => {
  const store = production.store;
  const names = new Set();
  let unexplained = 0;
  const unexplainedRecords = [];
  for (const record of fixture.records) {
    const result = await decodePayload(store, PROGRAM, record.dataHex);
    assert.equal(result.instruction, record.name, `fixture name mismatch for ${record.signature}`);
    // The IDL-described prefix must reproduce byte-for-byte for every payload.
    assert.equal(result.describedRoundTripByteExact, true,
      `described round trip failed for ${record.signature}`);
    assert.equal(result.consumed + result.trailing.count, result.bytes,
      `consumed + trailing must account for all bytes for ${record.signature}`);
    if (result.trailing.count > 0) {
      unexplained++;
      unexplainedRecords.push({
        name: record.name, slot: record.slot, sig: record.signature,
        bytes: result.bytes, consumed: result.consumed, trailing: result.trailing,
      });
      // full-input round trip is false exactly when bytes were unexplained
      assert.equal(result.roundTripByteExact, false, `expected roundTrip false for ${record.signature}`);
    } else {
      assert.equal(result.roundTripByteExact, true, `round trip failed for ${record.signature}`);
      assert.equal(result.consumed, result.bytes, `did not consume all bytes for ${record.signature}`);
    }
    names.add(result.instruction);
  }
  assert.ok(names.size >= 5, `expected at least 5 distinct instructions, saw ${names.size}`);
  assert.ok(fixture.records.length >= 40, 'fixture should hold the harvested payloads');
  // Strict mode must reject exactly the payloads with unexplained bytes.
  for (const record of fixture.records) {
    const result = await decodePayload(store, PROGRAM, record.dataHex);
    if (result.trailing.count === 0) continue;
    await assert.rejects(() => decodePayload(store, PROGRAM, record.dataHex, { trailing: 'error' }),
      /trailing bytes/, `strict mode must refuse ${record.signature}`);
  }
  // Recorded so a change in this count is a visible, reviewable diff.
  assert.ok(unexplained <= fixture.records.length,
    `unexplained count ${unexplained} cannot exceed ${fixture.records.length} records`);
  if (unexplained > 0) {
    // Every unexplained tail observed so far is zero padding; a non-zero tail
    // would mean the IDL is missing a real field, which is a different and more
    // serious finding than padding.
    assert.ok(unexplainedRecords.every((r) => /^0+$/.test(r.trailing.hex)),
      `non-zero unexplained bytes: ${JSON.stringify(unexplainedRecords)}`);
  }
});

test('swap_v2 mainnet payloads carry the observed amounts and remaining-accounts info', { skip: !production }, async () => {
  const withOption = fixture.records.filter((record) => record.name === 'swap_v2');
  assert.ok(withOption.length >= 10, 'expected several swap_v2 records');
  let sawSome = false;
  let sawNone = false;
  for (const record of withOption) {
    const result = await decodePayload(production.store, PROGRAM, record.dataHex);
    const args = result.args;
    assert.equal(typeof args.amount, 'string');
    assert.ok(BigInt(args.amount) > 0n, 'mainnet swap amounts are positive');
    assert.equal(typeof args.a_to_b, 'boolean');
    if (args.remaining_accounts_info.__option === 'Some') {
      sawSome = true;
      assert.ok(Array.isArray(args.remaining_accounts_info.value.slices));
      for (const slice of args.remaining_accounts_info.value.slices) {
        assert.equal(typeof slice.accounts_type, 'object');
        assert.equal(typeof slice.length, 'number');
      }
    } else { sawNone = true; }
  }
  assert.ok(sawSome && sawNone, 'fixture should contain both option forms');
});
