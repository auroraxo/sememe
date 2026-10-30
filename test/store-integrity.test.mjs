// The store reader must verify, not trust. Every check here was a real defect
// path measured on 2026-10-30 with this exact probe before the fix:
//
//   build a store from the committed Whirlpool snapshot (object + receipt),
//   rename one instruction in the object (still valid JSON), decode a real
//   mainnet swap_v2 payload against it — and `sememe decode` answered
//   `totally_honest_name` with `roundTripByteExact: true`, while quoting the
//   receipt's fingerprint as if it described the bytes it had just read.
//
// The consumer (`solana-tx-remix`) already re-hashed; the producing library did
// not. A store whose own reader is weaker than its consumer's is exactly the
// "one store, two strengths" failure the README says must not exist.
//
// Each test therefore asserts the REFUSAL and its reason, so a regression that
// merely throws "something went wrong" cannot pass, and a regression that
// decodes anyway cannot pass either.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { decodePayload, decodeStoredAccount, findStoredIdl } from '../src/decode.mjs';

const PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const OTHER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const idl = JSON.parse(
  await readFile(new URL('./fixtures/whirlpool-idl.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(
  await readFile(new URL('./fixtures/mainnet-whirlpool.json', import.meta.url), 'utf8'));
const { canonicalJson } = await import('../src/canonical.mjs');

/** A store exactly as `sememe pull` writes it: canonical object bytes, receipt over their hash. */
async function intactStore() {
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-integrity-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  const bytes = Buffer.from(canonicalJson(idl) + '\n');
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(store, 'objects', `${fingerprint}.json`), bytes);
  await writeFile(
    path.join(store, 'receipts', `${PROGRAM}-462039125-metadata-${fingerprint}.json`),
    JSON.stringify({ program: PROGRAM, fingerprint: `sha256:${fingerprint}`, slot: 462039125, source: 'metadata' }));
  return { store, fingerprint, bytes };
}

const swapV2 = fixture.records.find((record) => record.name === 'swap_v2');

test('the intact store still decodes a real mainnet payload (the control)', async () => {
  const { store } = await intactStore();
  try {
    const decoded = await decodePayload(store, PROGRAM, swapV2.dataHex);
    assert.equal(decoded.instruction, 'swap_v2');
    assert.equal(decoded.describedRoundTripByteExact, true);
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('a tampered object (valid JSON, one instruction renamed) is refused, not decoded', async () => {
  const { store, fingerprint } = await intactStore();
  try {
    const objectPath = path.join(store, 'objects', `${fingerprint}.json`);
    const tampered = JSON.parse(await readFile(objectPath, 'utf8'));
    const target = tampered.instructions.find(
      (instruction) => instruction.name === swapV2.name);
    assert.ok(target, 'fixture payload must map to a named instruction');
    target.name = 'totally_honest_name';
    await writeFile(objectPath, `${canonicalJson(tampered)}\n`);

    // The pre-fix behaviour was: instruction === 'totally_honest_name', exit 0.
    await assert.rejects(
      () => decodePayload(store, PROGRAM, swapV2.dataHex),
      (error) => /re-hashes to sha256:[a-f0-9]{64}/.test(error.message)
        && error.message.includes(fingerprint)
        && /disagree, refusing to decode/.test(error.message),
      'the refusal must name both hashes and say it will not decode',
    );
    // The account path shares the reader and must refuse the same damage.
    await assert.rejects(
      () => decodeStoredAccount(store, PROGRAM, Buffer.alloc(64, 7).toString('base64')),
      /disagree, refusing to decode/,
      'the account reader must refuse the same tampered object',
    );
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('a receipt bound to another program is refused before it is read as ours', async () => {
  const { store, fingerprint } = await intactStore();
  try {
    // Damage the binding, not the bytes: same object, receipt claims the object
    // belongs to a different program. Without the program check this receipt
    // would be selected (its filename still starts with the program) and its
    // object used as our IDL.
    const receiptPath = path.join(
      store, 'receipts', `${PROGRAM}-462039125-metadata-${fingerprint}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    receipt.program = OTHER_PROGRAM;
    await writeFile(receiptPath, JSON.stringify(receipt));

    await assert.rejects(
      () => findStoredIdl(store, PROGRAM),
      (error) => error.message.includes('is not a receipt for'),
      'a receipt naming another program must be refused by name',
    );
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('a receipt pointing at a missing object is refused, not ENOENT at parse time', async () => {
  const { store, fingerprint } = await intactStore();
  try {
    await rm(path.join(store, 'objects', `${fingerprint}.json`));
    await assert.rejects(
      () => findStoredIdl(store, PROGRAM),
      /claims object [a-f0-9]{64} but the store object is missing/,
      'a dangling receipt must say the object is missing',
    );
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('an object declaring a different program than the receipt is refused', async () => {
  const { store, fingerprint, bytes } = await intactStore();
  try {
    // Swap the content while keeping the receipt plausible: another program's
    // IDL, written under our object path, with a receipt that claims its hash.
    const foreign = JSON.parse(await readFile(
      new URL('./fixtures/jupiter-amm-v6-idl.json', import.meta.url), 'utf8'));
    const foreignBytes = Buffer.from(canonicalJson(foreign) + '\n');
    const foreignHash = createHash('sha256').update(foreignBytes).digest('hex');
    await writeFile(path.join(store, 'objects', `${foreignHash}.json`), foreignBytes);
    const receiptPath = path.join(
      store, 'receipts', `${PROGRAM}-462039125-metadata-${fingerprint}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    receipt.fingerprint = `sha256:${foreignHash}`;
    await writeFile(receiptPath, JSON.stringify(receipt));

    await assert.rejects(
      () => findStoredIdl(store, PROGRAM),
      (error) => error.message.includes('declares program'),
      'an object whose address is another program must be refused by name',
    );
    assert.ok(bytes.length > 0, 'intact store built');
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('malformed JSON in a store object is refused with the file named', async () => {
  const { store, fingerprint } = await intactStore();
  try {
    await writeFile(path.join(store, 'objects', `${fingerprint}.json`), '{not json');
    await assert.rejects(
      () => findStoredIdl(store, PROGRAM),
      /is not JSON/,
      'an unparsable object must be reported as unparsable',
    );
  } finally { await rm(store, { recursive: true, force: true }); }
});
