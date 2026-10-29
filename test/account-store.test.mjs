// The store path for accounts: same provenance guarantee as the instruction
// path — a receipt binds the program id to a fingerprinted object, and the
// decode is offline and reproducible.
//
// The store is rebuilt from the committed IDL snapshot (whose sha256 equals
// the receipt fingerprint) so this test never depends on a live pull.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeStoredAccount, findStoredIdl } from '../src/decode.mjs';

const PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const idl = JSON.parse(
  await readFile(new URL('./fixtures/whirlpool-idl.json', import.meta.url), 'utf8'));
const accounts = JSON.parse(
  await readFile(new URL('./fixtures/accounts-whirlpool-2026-10-29.json', import.meta.url), 'utf8'));

const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-account-store-'));
const fingerprint = 'f'.repeat(64);
await mkdir(path.join(store, 'objects'), { recursive: true });
await mkdir(path.join(store, 'receipts'), { recursive: true });
await writeFile(path.join(store, 'objects', `${fingerprint}.json`), JSON.stringify(idl));
await writeFile(path.join(store, 'receipts', `${PROGRAM}-42-metadata-${fingerprint}.json`),
  JSON.stringify({ program: PROGRAM, fingerprint: `sha256:${fingerprint}`, slot: 42, source: 'metadata' }));

test.after(async () => { await rm(store, { recursive: true, force: true }); });

test('the store holds the program the receipt names', async () => {
  const found = await findStoredIdl(store, PROGRAM);
  assert.equal(found.receipt.fingerprint, `sha256:${fingerprint}`);
});

test('a real mainnet account decodes from the store, offline, byte-exact', async () => {
  const account = accounts.accounts.find((entry) => {
    const head = Buffer.from(entry.dataBase64, 'base64').subarray(0, 8).toString('hex');
    return head === '3f95d10ce1806309';   // Whirlpool
  });
  assert.ok(account, 'no Whirlpool account in the fixture');
  const decoded = await decodeStoredAccount(store, PROGRAM, account.dataBase64);
  assert.equal(decoded.account, 'Whirlpool');
  assert.equal(decoded.roundTripByteExact, true);
  assert.equal(decoded.trailing.count, 0);
  assert.equal(decoded.consumed, decoded.bytes);
  assert.equal(decoded.discriminator, '3f95d10ce1806309');
  assert.equal(decoded.discriminatorSource, 'stored');
  assert.equal(decoded.idl.fingerprint, `sha256:${fingerprint}`);
  assert.equal(decoded.args.token_mint_a, 'So11111111111111111111111111111111111111112');
});

test('the same bytes decode the same way twice', async () => {
  const account = accounts.accounts[0];
  const first = await decodeStoredAccount(store, PROGRAM, account.dataBase64);
  const second = await decodeStoredAccount(store, PROGRAM, account.dataBase64);
  assert.deepEqual(first.args, second.args);
});

test('bytes that are not a known account are refused with a reason', async () => {
  await assert.rejects(
    () => decodeStoredAccount(store, PROGRAM, Buffer.alloc(64, 7).toString('base64')),
    /no account type in the stored IDL matches/);
});

test('forcing a name on bytes whose discriminator does not match is reported, not hidden', async () => {
  // The Oracle account's bytes with the discriminator byte changed: the caller
  // claims the type, so the decode runs — but the result says the bytes do not
  // carry the discriminator the IDL names.
  const account = accounts.accounts.find((entry) => {
    const head = Buffer.from(entry.dataBase64, 'base64').subarray(0, 8).toString('hex');
    return head === '8bc283b38cb3e5f4';   // Oracle
  });
  assert.ok(account);
  const bytes = Buffer.from(account.dataBase64, 'base64');
  bytes[0] ^= 0x01;

  // Without a name the bytes are refused: the discriminator table says no.
  await assert.rejects(
    () => decodeStoredAccount(store, PROGRAM, bytes.toString('base64')),
    /no account type in the stored IDL matches/);

  // With a forced name the decode runs, but it must not read as clean.
  const decoded = await decodeStoredAccount(store, PROGRAM, bytes.toString('base64'), { name: 'Oracle' });
  assert.equal(decoded.account, 'Oracle');
  assert.equal(decoded.discriminatorMatches, false,
    'a forced name on foreign bytes was reported as a matching discriminator');
});
