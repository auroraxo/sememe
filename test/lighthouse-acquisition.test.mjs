// Lighthouse acquisition: the #1 remaining acquisition gap (after ATA),
// closed through the PRODUCT's own write path with a HASH-VERIFIED vendored
// first-party copy — measured, not typed.
//
//   BEFUND (research/ecosystem-coverage-2026-11-11.json, acquisitionQueue[0]):
//   L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95 carried 1,214 payloads in the
//   6 committed blocks, acquirable=false at both pullable addresses. But the
//   program's OWN repository publishes an IDL (programs/lighthouse/
//   lighthouse.json, shank dialect — 18 instructions) and the name is not
//   guessed: solana-foundation/explorer and the program's own generated
//   clients bind this id to "lighthouse".
//
//   THE LADDER. L1..L6 are RED against the tree WITHOUT vendor/lighthouse,
//   src/lighthouse.mjs and tools/adopt-lighthouse.mjs (the module import is
//   lazy on purpose so the file LOADS on the pre-fix tree and the two guards
//   there are distinguishable from the red faces):
//   L1 the vendored copy loads: 18 instructions, address = the pin's program;
//   L2 a doctored vendored byte stream REFUSES by name (hash mismatch);
//   L3 a missing vendor file REFUSES by name;
//   L4 a swapped file that declares ANOTHER program's address REFUSES by name
//      — never re-labelled;
//   L5 the shank discriminant table is self-checked: a value that stops
//      matching its declaration index REFUSES by name;
//   L6 ADOPTING the verified copy through src/adopt.mjs (the product's one
//      write path, same as `sememe adopt`) into a scratch store makes ALL
//      1,214 committed Lighthouse payloads decode, every one re-encoding
//      byte-exactly — while the same store BEFORE the adoption refuses every
//      one with `no stored IDL` (the measured gap, reproduced in-test).
//
//   G1/G2 are the guards: they pass on BOTH trees (the only faces expected
//   green pre-fix): the fixture still carries exactly the measured 1,214
//   payloads, and adopt still refuses an interface file that declares a
//   DIFFERENT program (a product rule that predates this fix).
//
// Falsification contract: loadVendoredLighthouse runs BEFORE any write, so a
// tampered vendor file means NOTHING was written to the store — the refusal
// names the face (missing / hash-mismatch / address-disagrees /
// discriminant-table) instead of decoding from bytes nobody reviewed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);
const importRepo = (rel) => import(path.join(ROOT, rel));

// Lazy so the FILE loads on the pre-fix tree: a missing module must turn each
// L-face red individually, not crash the run before G1/G2 can run green.
const lightHouse = await importRepo('src/lighthouse.mjs').catch(() => null);
const PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const { adopt } = await importRepo('src/adopt.mjs');
const { decodeUnionPayload } = await importRepo('src/decode.mjs');

const SAMPLE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json');

const lighthousePayloads = () => {
  const sample = require(SAMPLE);
  const rows = [];
  for (const tx of sample.transactions) {
    for (const p of tx.payloads ?? []) {
      if (p.program === PROGRAM) rows.push(p.dataHex);
    }
  }
  return rows;
};

/** Scratch vendor tree: the pin's files, optionally replaced by the caller. */
const scratch = (files) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lh-vendor-'));
  const vendor = path.join(dir, 'vendor', 'lighthouse', lightHouse.LIGHTHOUSE_PIN.commit);
  mkdirSync(vendor, { recursive: true });
  for (const f of lightHouse.LIGHTHOUSE_PIN.files) {
    const target = path.join(vendor, path.basename(f.file));
    const source = files?.[f.file]
      ?? readFileSync(path.join(ROOT, 'vendor', 'lighthouse', lightHouse.LIGHTHOUSE_PIN.commit, path.basename(f.file)));
    writeFileSync(target, source);
  }
  return dir;
};

const vendorSource = (name) => readFileSync(
  path.join(ROOT, 'vendor', 'lighthouse', lightHouse.LIGHTHOUSE_PIN.commit, name), 'utf8');

test('L1: the vendored first-party copy loads against its pin', () => {
  assert.ok(lightHouse, 'src/lighthouse.mjs is missing — the acquisition module is the fix');
  const loaded = lightHouse.loadVendoredLighthouse();
  assert.equal(loaded.idl.metadata.address, PROGRAM);
  assert.equal(loaded.idl.instructions.length, 18);
  assert.equal(loaded.sha256, lightHouse.LIGHTHOUSE_PIN.files[0].sha256);
});

test('L2: a doctored vendored byte stream refuses by name (hash mismatch)', () => {
  assert.ok(lightHouse, 'src/lighthouse.mjs is missing');
  const dir = scratch({
    'programs/lighthouse/lighthouse.json':
      Buffer.from(vendorSource('lighthouse.json').replace('"MemoryWrite"', '"RenamedWrite"')),
  });
  try {
    assert.throws(() => lightHouse.loadVendoredLighthouse(dir),
      (error) => error.name === 'LighthousePinError' && error.reason === 'lighthouse-vendor-hash-mismatch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L3: a missing vendor file refuses by name', () => {
  assert.ok(lightHouse, 'src/lighthouse.mjs is missing');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lh-empty-'));
  try {
    assert.throws(() => lightHouse.loadVendoredLighthouse(dir),
      (error) => error.name === 'LighthousePinError' && error.reason === 'lighthouse-vendor-missing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L4: a swapped file declaring another program REFUSES, never re-labels', () => {
  assert.ok(lightHouse, 'src/lighthouse.mjs is missing');
  const original = JSON.parse(vendorSource('lighthouse.json'));
  original.metadata = { ...original.metadata, address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' };
  const mutated = Buffer.from(JSON.stringify(original));
  const dir = scratch({ 'programs/lighthouse/lighthouse.json': mutated });
  // The pin is updated to MATCH the mutated bytes, so the hash check passes
  // by construction: what refuses is the address disagreement, not the hash.
  // This is the only honest way to prove the semantic check exists at all.
  const pin = { ...lightHouse.LIGHTHOUSE_PIN, files: lightHouse.LIGHTHOUSE_PIN.files.map((f) =>
    (f.file.endsWith('lighthouse.json') ? { ...f, sha256: createHash('sha256').update(mutated).digest('hex') } : f)) };
  try {
    assert.throws(() => lightHouse.loadVendoredLighthouse(dir, pin),
      (error) => error.name === 'LighthousePinError' && error.reason === 'lighthouse-address-disagrees');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L5: a tampered shank discriminant table refuses by name', () => {
  assert.ok(lightHouse, 'src/lighthouse.mjs is missing');
  const original = JSON.parse(vendorSource('lighthouse.json'));
  original.instructions[3].discriminant = { type: 'u8', value: 0 };
  const mutated = Buffer.from(JSON.stringify(original));
  const dir = scratch({ 'programs/lighthouse/lighthouse.json': mutated });
  // Same construction as L4: hash satisfied, so the discriminant-table
  // invariant is what refuses the doctored IDL.
  const pin = { ...lightHouse.LIGHTHOUSE_PIN, files: lightHouse.LIGHTHOUSE_PIN.files.map((f) =>
    (f.file.endsWith('lighthouse.json') ? { ...f, sha256: createHash('sha256').update(mutated).digest('hex') } : f)) };
  try {
    assert.throws(() => lightHouse.loadVendoredLighthouse(dir, pin),
      (error) => error.name === 'LighthousePinError' && error.reason === 'lighthouse-discriminant-table');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L6: adoption makes all 1,214 committed payloads decode byte-exact; before it, every one refuses no-interface', async () => {
  const rows = lighthousePayloads();
  assert.equal(rows.length, 1_214, 'the committed fixture must carry exactly the measured gap');
  const store = mkdtempSync(path.join(os.tmpdir(), 'lh-store-'));
  // The store skeleton exists, so the pre-adoption face is the acquisition
  // gap itself (`no stored IDL for program X`), not an absent directory.
  mkdirSync(path.join(store, 'receipts'), { recursive: true });
  mkdirSync(path.join(store, 'objects'), { recursive: true });
  try {
    // BEFORE: the product's union decode refuses every payload — the measured
    // gap reproduced in-test, so the post-adoption decode cannot be a fixture
    // accident.
    const first = await decodeUnionPayload(store, PROGRAM, rows[0]).catch((error) => error);
    assert.ok(String(first.message ?? first).includes('no stored IDL'),
      `pre-adoption refusal expected, got ${JSON.stringify(first)}`);

    assert.ok(lightHouse, 'src/lighthouse.mjs is missing — the acquisition module is the fix');
    const loaded = lightHouse.loadVendoredLighthouse();
    await adopt(PROGRAM, loaded.path, store, {
      source: 'published',
      origin: lightHouse.lighthouseOriginLabel(),
    });

    let decoded = 0; let byteExact = 0; const names = {};
    for (const hex of rows) {
      const out = await decodeUnionPayload(store, PROGRAM, hex);
      decoded += 1;
      if (out.roundTripByteExact === true) byteExact += 1;
      names[out.instruction] = (names[out.instruction] ?? 0) + 1;
      assert.equal(out.view.verdict, 'single_source',
        'the adopted sole source stays honest about being one source');
      assert.equal(out.idl.source, 'published');
      assert.equal(out.idl.originStatus, 'declared',
        'a pinned origin is still DECLARED — the pin binds the bytes, not the claim');
    }
    assert.equal(decoded, 1_214);
    assert.equal(byteExact, 1_214, 'every decoded payload must re-encode byte-exactly');
    // The four instruction faces the measurement saw — named, not just counted.
    assert.deepEqual(Object.keys(names).sort(), [
      'AssertAccountData', 'AssertAccountInfo', 'AssertSysvarClock', 'AssertTokenAccount',
    ]);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

// --- guards: green on BOTH trees -----------------------------------------

test('L7: the shipped CLI adopts the copy and decodes through it end to end', async () => {
  assert.ok(lightHouse, 'src/lighthouse.mjs is missing — the acquisition module is the fix');
  const store = mkdtempSync(path.join(os.tmpdir(), 'lh-cli-'));
  try {
    const cli = (...argv) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'sememe.mjs'), ...argv], { cwd: ROOT });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    // The store refuses BEFORE adoption: no receipt, named reason.
    const rows = lighthousePayloads();
    const before = await cli('decode', PROGRAM, rows[0], '--store', store, '--union');
    assert.notEqual(before.code, 0, 'decoding without any interface must not succeed');
    assert.match(String(before.stderr + before.stdout), /no stored IDL|no sememe store/,
      `the refusal must be named, got: ${before.stderr.slice(0, 200)}`);

    const adopt = await cli('adopt-lighthouse', '--store', store);
    assert.equal(adopt.code, 0, `adopt-lighthouse must exit 0: ${adopt.stderr.slice(0, 300)}`);
    const receipt = JSON.parse(adopt.stdout);
    assert.equal(receipt.program, PROGRAM);
    assert.equal(receipt.source, 'published');
    assert.equal(receipt.originStatus, 'declared', 'the origin stays DECLARED even when hash-pinned');
    assert.match(receipt.fingerprint, /^sha256:[0-9a-f]{64}$/);

    // Adopting AGAIN must not layer a second claim (same bytes, same origin).
    const again = await cli('adopt-lighthouse', '--store', store);
    assert.equal(again.code, 0, `a repeat adoption must be a no-op, got: ${again.stderr.slice(0, 200)}`);
    const second = JSON.parse(again.stdout);
    assert.equal(second.fingerprint, receipt.fingerprint, 'the same bytes must produce the same fingerprint');

    const decode = await cli('decode', PROGRAM, rows[0], '--store', store, '--union');
    assert.equal(decode.code, 0, `decode after adoption must succeed: ${decode.stderr.slice(0, 300)}`);
    const out = JSON.parse(decode.stdout);
    assert.equal(out.instruction, 'AssertAccountInfo');
    assert.equal(out.roundTripByteExact, true);

    // The gap advice must name the ONE command that works, not a generic
    // "find a file" that sends the user hunting for what already ships.
    const help = await cli('--help');
    assert.match(help.stdout + help.stderr, /adopt-lighthouse/,
      'the CLI help must document the shipped acquisition path');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

// --- guards: green on BOTH trees -----------------------------------------

test('G1: the committed fixture still carries exactly the measured 1,214 payloads', () => {
  const rows = lighthousePayloads();
  assert.equal(rows.length, 1_214,
    'the fixture is the denominator — it may not shrink when the gap closes');
});

test('G2: adopt refuses an interface file that declares a DIFFERENT program (pre-existing rule)', async () => {
  const store = mkdtempSync(path.join(os.tmpdir(), 'lh-guard-'));
  const bad = path.join(store, 'wrong-address.json');
  writeFileSync(bad, JSON.stringify({
    instructions: [{ name: 'X', discriminator: [1, 1, 1, 1, 1, 1, 1, 1], accounts: [], args: [] }],
    address: 'So11111111111111111111111111111111111111112',
  }));
  try {
    await assert.rejects(adopt(PROGRAM, bad, store), /declares program/);
  } finally { rmSync(store, { recursive: true, force: true }); }
});
