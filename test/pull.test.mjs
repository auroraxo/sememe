import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as zlib from 'node:zlib';
import { PublicKey } from '@solana/web3.js';
import { pull, canonicalJson } from '../src/pull.mjs';

const program = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const idl = { instructions: [{ name: 'swap', args: [] }], address: program };
const account = (value = idl) => {
  const compressed = zlib.deflateSync(Buffer.from(JSON.stringify(value)));
  const header = Buffer.alloc(44); Buffer.from([24, 70, 98, 191, 58, 144, 123, 158]).copy(header);
  header.writeUInt32LE(compressed.length, 40);
  return { owner: program, data: [Buffer.concat([header, compressed]).toString('base64'), 'base64'] };
};
const metadataAccount = (value = idl) => {
  const text = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(96);
  header[0] = 2;
  // The public Whirlpool program ID is bound into the Program Metadata account.
  importProgramBytes().copy(header, 1);
  header[66] = 1;
  header.write('idl', 67);
  header[83] = 1; // UTF-8, uncompressed, in-account JSON
  header.writeUInt32LE(text.length, 87);
  return { owner: 'ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S',
    data: [Buffer.concat([header, text]).toString('base64'), 'base64'] };
};
function importProgramBytes() { return new PublicKey(program).toBuffer(); }
const mock = (canonical, legacy, slot = 55) => async () => ({ ok: true,
  json: async () => ({ result: { context: { slot }, value: [canonical, legacy] } }) });
const temporary = async (fn) => {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-pull-test-'));
  try { return await fn(store); } finally { await rm(store, { recursive: true, force: true }); }
};

test('content addressing stable across JSON property order', () => {
  assert.equal(canonicalJson({ b: 2, a: { z: true, y: null } }), canonicalJson({ a: { y: null, z: true }, b: 2 }));
});
test('pull stores one verified immutable artifact and returns provenance', async () => temporary(async (store) => {
  const fetcher = mock(null, account());
  const first = await pull(program, store, 'https://mock.invalid/rpc', fetcher);
  const second = await pull(program, store, 'https://mock.invalid/rpc', fetcher);
  assert.equal(first.source, 'anchor'); assert.equal(first.slot, 55);
  assert.match(first.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(second.fingerprint, first.fingerprint);
  const written = JSON.parse(await readFile(first.path, 'utf8'));
  assert.deepEqual(written, idl);
  assert.equal((await readdir(path.join(store, 'objects'))).length, 1);
  const receipt = JSON.parse(await readFile(first.receiptPath, 'utf8'));
  assert.equal(receipt.fingerprint, first.fingerprint);
  assert.equal(receipt.slot, 55);
  assert.equal((await readdir(path.join(store, 'receipts'))).length, 1);
}));
test('canonical metadata wins when both IDL channels exist', async () => temporary(async (store) => {
  const result = await pull(program, store, 'https://mock.invalid', mock(metadataAccount(), account()));
  assert.equal(result.source, 'metadata');
  assert.equal(result.instructionCount, 1);
}));
test('corrupted object is refused rather than overwritten', async () => temporary(async (store) => {
  const first = await pull(program, store, 'https://mock.invalid', mock(null, account()));
  await writeFile(first.path, 'corrupt');
  await assert.rejects(pull(program, store, 'https://mock.invalid', mock(null, account())),
    /corrupted local object/);
}));
test('missing or wrong-owner accounts never create an object', async () => temporary(async (store) => {
  await assert.rejects(pull(program, store, 'https://mock.invalid', mock(null, null)), /no verified on-chain IDL/);
  await assert.rejects(pull(program, store, 'https://mock.invalid', mock(null, { ...account(), owner: '11111111111111111111111111111111' })), /wrong owner/);
  await assert.rejects(pull(program, store, 'https://mock.invalid', mock(null, account({ instructions: [{ name: 'swap' }], address: '11111111111111111111111111111111' }))), /another program/);
  await assert.rejects(readdir(path.join(store, 'objects')), { code: 'ENOENT' });
}));
test('input ID and RPC transport are validated before writing', async () => temporary(async (store) => {
  await assert.rejects(pull('invalid', store, 'https://mock.invalid'), /Non-base58 character|Invalid public key input/);
  await assert.rejects(pull(program, store, 'http://mock.invalid'), /HTTPS RPC URL/);
  await assert.rejects(readdir(path.join(store, 'objects')), { code: 'ENOENT' });
}));
