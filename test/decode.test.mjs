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

// The production IDL: prefer the local store from the qualification run, fall
// back to an explicit path so CI can run the same assertion.
async function productionIdl() {
  const store = process.env.SEMEME_TEST_STORE ?? path.join(os.tmpdir(), 'sememe-user-zero');
  try {
    const { idl } = await findStoredIdl(store, PROGRAM);
    return { idl, store, receipt: null };
  } catch { /* fall through */ }
  return null;
}
const production = await productionIdl();

async function temporaryStore(idl) {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-decode-test-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  const fingerprint = 'f'.repeat(64);
  await writeFile(path.join(store, 'objects', `${fingerprint}.json`), JSON.stringify(idl));
  await writeFile(
    path.join(store, 'receipts', `${PROGRAM}-42-metadata-${fingerprint}.json`),
    JSON.stringify({ program: PROGRAM, fingerprint: `sha256:${fingerprint}`, slot: 42, source: 'metadata' }));
  return store;
}
const withStore = async (idl, fn) => {
  const store = await temporaryStore(idl);
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
  const store = await temporaryStore(minimal);
  try {
    const payload = Buffer.from('01020304050607082a000000000000000100000000000000', 'hex');
    const result = await decodePayload(store, PROGRAM, payload.toString('base64')
      .replace(/\+/g, '').slice(0, 0) + payload.toString('hex'));
    assert.equal(result.instruction, 'swap_like');
    assert.equal(result.discriminator, '0102030405060708');
    assert.deepEqual(result.args, { amount: '42', limit: '1' });
    assert.equal(result.roundTripByteExact, true);
    assert.equal(result.idl.fingerprint, `sha256:${'f'.repeat(64)}`);
    assert.equal(result.consumed, result.bytes);
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('decodePayload refuses an unknown program in the store', async () => {
  const store = await temporaryStore(minimal);
  try {
    await assert.rejects(() => decodePayload(store, 'ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S', 'aa'),
      /no stored IDL for program/);
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('unknown discriminator and trailing bytes are errors, not guesses', async () => {
  const store = await temporaryStore(minimal);
  try {
    await assert.rejects(() => decodePayload(store, PROGRAM, 'ffffffff0100000000000000'),
      /unknown instruction discriminator/);
    await assert.rejects(() => decodePayload(store, PROGRAM, '01020304050607082a000000000000000100000000000000ff'),
      /trailing bytes/);
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('all 26 real mainnet Whirlpool payloads decode byte-exactly', { skip: !production }, async () => {
  const store = production.store;
  const names = new Set();
  for (const record of fixture.records) {
    const result = await decodePayload(store, PROGRAM, record.dataHex);
    assert.equal(result.instruction, record.name, `fixture name mismatch for ${record.signature}`);
    assert.equal(result.roundTripByteExact, true, `round trip failed for ${record.signature}`);
    assert.equal(result.consumed, result.bytes, `did not consume all bytes for ${record.signature}`);
    names.add(result.instruction);
  }
  assert.ok(names.size >= 5, `expected at least 5 distinct instructions, saw ${names.size}`);
  assert.ok(fixture.records.length >= 20, 'fixture should hold the harvested payloads');
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
