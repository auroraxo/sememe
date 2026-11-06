// A base58 payload is a payload. The hex payload and the base58 payload of
// the same bytes must decode to the same thing.
//
// Why this file exists: the CLI accepts "base58 or hex" for every payload
// argument (bin/sememe.mjs help text), and the README's own union-decode
// walkthrough uses a base58 payload. But the base58 path produced bytes that
// were NOT Buffers, and three separate consumers need Buffer methods:
//
//   D1  src/union.mjs  — `Buffer.isBuffer(bytes)` refuses a plain Uint8Array,
//                        so `sememe decode --union <program> <base58>` failed
//                        with "unionDecode needs the payload bytes as a
//                        Buffer" on EVERY base58 payload, while the same
//                        payload as hex decoded fine.
//   D2  src/codec.mjs  — f32/f64 read via `slice.readFloatLE`/`readDoubleLE`,
//                        which a plain Uint8Array does not have:
//                        "slice.readDoubleLE is not a function".
//   D3  src/codec.mjs  — a `bytes` argument is rendered with
//                        `slice.toString('base64')`; on a plain Uint8Array
//                        that is a COMMA-SEPARATED LIST ("1,2,3,255"), not
//                        base64 — silent corruption, not an error.
//
// All three were measured against the PUBLISHED v0.4.4 install (a pinned
// `npm install github:auroraxo/sememe#v0.4.4`), not against a working tree.
//
// The rule this file pins: the base58 path and the hex path are the same
// path. Not "usually the same" — the same. Every assertion below is a
// base58-vs-hex equality, so an implementation that keeps them apart fails.
//
// The mutant at the end is the falsification: reverting `decodeBase58` to a
// plain Uint8Array must turn this file red.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { decodeBase58, encodeBase58 } from '../src/base58.mjs';
import { parsePayload, decodePayload, decodeUnionPayload } from '../src/decode.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'sememe.mjs');

// The measured traffic store: real pulled IDLs with real receipts.
const STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const OPENBOOK = 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb';
const FARMS = 'FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr';

/** Anchor's global discriminator for an instruction name (sha256 rule). */
const { globalDiscriminator } = await import('../src/discriminators.mjs');

/** Build an instruction payload: discriminator ++ args, as the wire has it. */
function payload(name, ...argBytes) {
  return Buffer.concat([Buffer.from(globalDiscriminator(name)), ...argBytes]);
}

// A real measured payload from the pump.fun traffic harvest: a `sell_v3`
// instruction, 24 bytes, hex `1c92de7726c469d584c159ce7818000096a7ad1300000000`.
const pumpHarvest = JSON.parse(
  await readFile(path.join(ROOT, 'test', 'fixtures', 'harvest-pump-2026-10-30.json'), 'utf8'));
const pumpPayload = Buffer.from(
  pumpHarvest.transactions
    .flatMap((tx) => tx.payloads ?? [])
    .find((p) => p.dataHex === '1c92de7726c469d584c159ce7818000096a7ad1300000000')
    .dataHex,
  'hex');

// ---------------------------------------------------------------- the contract

test('base58 decoding yields bytes the whole decode path can read', () => {
  // The root cause, named: `decodeBase58` returned a plain Uint8Array.
  const decoded = decodeBase58('3c5s1W8njd3Hcyadj9sY46ZmGiUYCxR8b');
  assert.ok(Buffer.isBuffer(decoded),
    'decodeBase58 must return a Buffer: the decode path reads floats and '
    + 'base64 with Buffer methods, which a plain Uint8Array does not have');
  // ...and it stays what it always was, for every existing caller.
  assert.ok(decoded instanceof Uint8Array, 'a Buffer is still a Uint8Array');
  assert.equal(decoded.length, 24);
  assert.equal(decoded.toString('hex'), '1c92de7726c469d584c159ce7818000096a7ad1300000000');
});

test('parsePayload gives both encodings the same KIND of bytes', () => {
  const hex = '1c92de7726c469d584c159ce7818000096a7ad1300000000';
  const fromHex = parsePayload(hex);
  const fromBase58 = parsePayload(encodeBase58(Buffer.from(hex, 'hex')));
  assert.ok(Buffer.isBuffer(fromHex), 'the hex path was already a Buffer');
  assert.ok(Buffer.isBuffer(fromBase58),
    'the base58 path must be a Buffer too — one payload, one kind of bytes');
  assert.equal(fromBase58.toString('hex'), fromHex.toString('hex'));
});

test('D1: a base58 payload decodes through the union path (D1 refused every base58 payload)', async () => {
  const hex = pumpPayload.toString('hex');
  const base58 = encodeBase58(pumpPayload);
  const fromHex = await decodeUnionPayload(STORE, PUMP, hex);
  const fromBase58 = await decodeUnionPayload(STORE, PUMP, base58);
  assert.equal(fromBase58.name, fromHex.name, 'the same bytes must decode to the same instruction');
  assert.deepEqual(fromBase58.args, fromHex.args, 'the same bytes must decode to the same fields');
  assert.equal(fromBase58.view.verdict, fromHex.view.verdict, 'the same verdict for the same bytes');
});

test('D2: a base58 payload with an f64 argument decodes to the same number as hex', async () => {
  // OpenBook v2 `stubOracleCreate { price: f64 }` — measured against the
  // published v0.4.4 install, the base58 form died with
  // "slice.readDoubleLE is not a function" while the hex form decoded.
  const bytes = payload('stubOracleCreate', Buffer.from('000000000000f83f', 'hex'));
  const fromHex = await decodePayload(STORE, OPENBOOK, bytes.toString('hex'));
  const fromBase58 = await decodePayload(STORE, OPENBOOK, encodeBase58(bytes));
  assert.equal(fromHex.args.price, 1.5);
  assert.equal(fromBase58.args.price, 1.5, 'the base58 form must decode to the same f64');
  assert.equal(fromBase58.roundTripByteExact, true);
});

test('D3: a base58 payload with a bytes argument yields base64, not a comma list', async () => {
  // `updateFarmConfig { mode: u16, data: bytes }` on the farms program. The
  // hex form gave base64 ("3q2+7w=="); the base58 form produced the CORRUPT
  // "1,2,3,255" string (and then refused to re-encode it).
  const bytes = payload(
    'updateFarmConfig',
    Buffer.from([1, 0]),
    Buffer.from([4, 0, 0, 0]),
    Buffer.from('deadbeef', 'hex'));
  const fromHex = await decodePayload(STORE, FARMS, bytes.toString('hex'));
  const fromBase58 = await decodePayload(STORE, FARMS, encodeBase58(bytes));
  assert.equal(fromHex.args.data, '3q2+7w==');
  assert.equal(fromBase58.args.data, '3q2+7w==',
    'a bytes argument must be base64 in both encodings');
  assert.ok(!fromBase58.args.data.includes(','),
    'a comma-separated byte list is corruption, not base64');
});

test('the CLI accepts a base58 payload on the union path (the README walkthrough)', async () => {
  const base58 = encodeBase58(pumpPayload);
  const { stdout } = await run(process.execPath, [
    CLI, 'decode', '--union', PUMP, base58, '--store', STORE,
  ], { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 });
  const decoded = JSON.parse(stdout);
  assert.equal(decoded.name, 'sell_v3');
  assert.ok(!/needs the payload bytes as a Buffer/.test(stdout),
    'the CLI must not refuse a base58 payload as "not a Buffer"');
});

test('the CLI accepts a base58 payload on the plain path too', async () => {
  const bytes = payload('stubOracleCreate', Buffer.from('000000000000f83f', 'hex'));
  const { stdout } = await run(process.execPath, [
    CLI, 'decode', OPENBOOK, encodeBase58(bytes), '--store', STORE,
  ], { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(JSON.parse(stdout).args.price, 1.5);
});

test('the hex path is unchanged by the fix (no regression in the other direction)', () => {
  const hex = '1c92de7726c469d584c159ce7818000096a7ad1300000000';
  assert.deepEqual(parsePayload(hex), Buffer.from(hex, 'hex'));
  assert.deepEqual(parsePayload(`0x${hex}`), Buffer.from(hex, 'hex'));
});

// ------------------------------------------------------------- falsification

/** Write a mutant of a src/ module next to the original (so its relative
 * imports resolve against the real tree), import it, and delete it after.
 * The real module is never modified. */
async function withMutant(module, name, mutate) {
  const source = await readFile(path.join(ROOT, 'src', module), 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `${name}: the mutation must actually change the source`);
  const mutantPath = path.join(ROOT, 'src', `.mutant-${name}-${process.pid}.mjs`);
  try {
    await writeFile(mutantPath, mutated);
    return await import(mutantPath);
  } finally {
    await rm(mutantPath, { force: true });
  }
}

test('M1: reverting decodeBase58 to a plain Uint8Array breaks the pinned contract', async () => {
  const mutant = await withMutant('base58.mjs', 'b58-uint8', (source) => source.replace(
    'return Buffer.from(out.buffer, out.byteOffset, out.byteLength);',
    'return out;'));
  const bytes = mutant.decodeBase58('3c5s1W8njd3Hcyadj9sY46ZmGiUYCxR8b');
  assert.equal(Buffer.isBuffer(bytes), false,
    'M1 must actually produce a non-Buffer, otherwise the contract pins nothing');
  assert.equal(bytes.length, 24, 'the mutant decodes the right bytes');
  // ...and the REAL module satisfies the contract.
  const real = decodeBase58('3c5s1W8njd3Hcyadj9sY46ZmGiUYCxR8b');
  assert.equal(Buffer.isBuffer(real), true);
});

test('M2: the codec-level guard is load-bearing, not decorative', async () => {
  // The Cursor normalizes its bytes to a Buffer. If that guard is removed
  // AND decodeBase58 goes back to a plain Uint8Array, the measured f64
  // failure comes back — which is what makes the second guard worth having
  // (a caller outside this repo may hand over any byte array).
  const mutant = await withMutant('codec.mjs', 'cursor-raw', (source) => source.replace(
    'this.bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);',
    'this.bytes = bytes;'));
  const idl = {
    instructions: [{
      name: 'stubOracleCreate',
      discriminator: Array.from(globalDiscriminator('stubOracleCreate')),
      args: [{ name: 'price', type: 'f64' }],
    }],
    types: [],
  };
  const wire = Buffer.concat([
    Buffer.from(globalDiscriminator('stubOracleCreate')),
    Buffer.from('000000000000f83f', 'hex'),
  ]);
  // the real codec decodes the plain-Uint8Array bytes fine (the guard) ...
  const { decodeInstructionData } = await import('../src/codec.mjs');
  assert.equal(decodeInstructionData(idl, new Uint8Array(wire)).args.price, 1.5);
  // ... and without the guard the measured failure is back.
  assert.throws(
    () => mutant.decodeInstructionData(idl, new Uint8Array(wire)),
    /readDoubleLE is not a function/,
    'M2 must reproduce the measured f64 failure, otherwise the guard pins nothing');
});
