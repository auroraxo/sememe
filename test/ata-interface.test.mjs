import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The ATA table (SPL Associated Token Account) is DERIVED from the vendored
 * upstream Rust sources (`src/ata-interface.mjs`), committed as a reviewable
 * artifact (`interface/ata-<program>.json`), and re-derived AT LOAD: the
 * module refuses to decode unless the committed artifact equals a fresh
 * derivation of the vendored bytes — the two-check contract src/native.mjs,
 * src/token.mjs and src/raydium.mjs already proved.
 *
 * This program publishes NO IDL account to pull (measured 2026-11-11 at both
 * pullable addresses over 6 finalized mainnet blocks: 1,410 payloads, the
 * single largest acquisition gap), yet its wire rule is trivially upstream's
 * own text: a borsh-serialised unit enum (Create=0, CreateIdempotent=1,
 * RecoverNested=2) plus the processor's empty-input fallback to Create.
 *
 * These tests pin that contract by mutation, not by assertion:
 *
 *   1. The committed artifact is exactly today's derivation (a stale
 *      artifact fails the CLI check, so nobody approves a table nobody
 *      regenerated).
 *   2. The wire shapes and runtime verdicts are upstream's own: the borsh
 *      serialise arms' integer pushes, the empty-input fallback, the
 *      borsh try_from_slice judge and its InvalidInstructionData refusal.
 *   3. Every MEASURED payload in the committed ecosystem sample decodes
 *      byte-exactly through the product decoder — the 1,410-payload
 *      acquisition gap must be empty, not smaller.
 *   4. A tampered ARTIFACT refuses the load.
 *   5. A tampered VENDORED SOURCE refuses the load (the hash it claims).
 *   6. A MISSING vendored source refuses the load.
 *
 * Guards (the only tests allowed to pass on the pre-table tree):
 *   G1. The ATA program must stay OUT of the token table — a neighbouring
 *       table swallowing it would make `decode-token` answer for a program
 *       it has no pin for.
 *   G2. A real measured SPL Token payload keeps decoding through the token
 *       table — the new table must not disturb its neighbour.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SAMPLE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json');

/** A throwaway copy of everything `src/ata.mjs` reads at load time. */
function copyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-ata-'));
  for (const part of ['src', 'interface', 'vendor']) {
    fs.cpSync(path.join(ROOT, part), path.join(dir, part), { recursive: true });
  }
  return dir;
}

/** Import `src/ata.mjs` from a copy; the load-time check runs on import. */
function loadFrom(dir) {
  const target = `${pathToFileURL(path.join(dir, 'src', 'ata.mjs')).href}?t=${Date.now()}-${Math.random()}`;
  return import(target);
}

test('the committed ata artifact is exactly what the derivation produces', () => {
  const out = execFileSync(process.execPath, ['tools/ata-interface.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(out.trim(), /: current \(\d+ variants, sha256:[0-9a-f]{64}\)/);
});

test('the derivation reads upstream\'s own wire and runtime, not a transcription', async () => {
  const { deriveAtaInterface, ATA_SPEC, ATA_PINS } =
    await import(path.join(ROOT, 'src', 'ata-interface.mjs'));
  const doc = deriveAtaInterface(ATA_SPEC);

  // The program id is the vendored source's own declare_id, not a loose
  // constant: the derivation must have taken it from the vendored text.
  assert.equal(doc.program, ATA);
  assert.equal(doc.source.programSource, 'vendored interface/src/lib.rs declare_id');

  // borsh enum: Create=0, CreateIdempotent=1, RecoverNested=2 — the integers
  // upstream's serialise arms push, NOT declaration indices of some other
  // spelling, and NOT a set that misses a declared variant.
  assert.deepEqual(
    doc.instructions.map((ix) => ({ tag: ix.tag, name: ix.name })),
    [
      { tag: 0, name: 'Create' },
      { tag: 1, name: 'CreateIdempotent' },
      { tag: 2, name: 'RecoverNested' },
    ],
  );
  for (const ix of doc.instructions) {
    assert.deepEqual(ix.args, [], 'every ATA variant is a borsh unit variant: no args');
    assert.equal(ix.wire, 'borsh-unit-enum');
  }

  // The runtime verdicts are the processor's own text at this pin:
  // empty input falls back to Create, everything else is judged by borsh
  // try_from_slice, and an unjudged input is InvalidInstructionData.
  assert.equal(doc.runtime.emptyInputFallback, 'Create');
  assert.match(doc.runtime.judge, /try_from_slice/);
  assert.match(doc.runtime.unknownInputRefusal, /InvalidInstructionData/);
  assert.match(doc.selector.encoding, /borsh/);
  assert.match(doc.selector.encoding, /empty input/);

  // Every vendored file is hashed: a swapped source cannot quietly survive.
  assert.ok(ATA_PINS.interface.files.length >= 2, 'instruction source and processor are both pinned');
  for (const file of doc.source.files) {
    assert.match(file.sha256, /^sha256:[0-9a-f]{64}$/, `${file.file} must carry a real sha256`);
  }
});

test('every measured ATA payload decodes byte-exactly — the gap is EMPTY, not smaller', async () => {
  const { decodeAtaInstruction } = await import(path.join(ROOT, 'src', 'ata.mjs'));
  const sample = JSON.parse(await readFile(SAMPLE, 'utf8'));
  const rows = [];
  for (const tx of sample.transactions) {
    for (const payload of tx.payloads) {
      if (payload.program === ATA) rows.push(payload.dataHex);
    }
  }
  assert.equal(rows.length, 1_410,
    'the measured gap this table closes is 1,410 payloads (the committed artifact names it)');

  const names = new Map();
  for (const hex of rows) {
    const decoded = decodeAtaInstruction(ATA, Buffer.from(hex, 'hex'), { trailing: 'report' });
    assert.ok(decoded.name, 'the payload must be NAMED, not refused');
    if (hex === '') {
      // The 4 EMPTY payloads take the processor's own fallback: upstream
      // executes empty input as Create. They are NAMED, not refused — but
      // their canonical re-encoding is the one byte [0], so they are the
      // only rows that do not re-encode byte-for-byte. Saying so is the
      // honest number; calling them byte-exact would be a claim about a
      // wire form upstream never writes.
      assert.equal(decoded.name, 'Create');
      assert.equal(decoded.selectorWidth, 0);
      assert.equal(decoded.roundTripByteExact, false);
      assert.equal(decoded.trailing.count, 0);
      names.set(decoded.name, (names.get(decoded.name) ?? 0) + 1);
      continue;
    }
    assert.equal(decoded.roundTripByteExact, true,
      `a unit enum with no args must re-encode byte-exactly, got ${hex}`);
    assert.equal(decoded.trailing.count, 0);
    names.set(decoded.name, (names.get(decoded.name) ?? 0) + 1);
  }
  // The measured traffic only ever creates: 1,343 idempotent (0x01),
  // 63 plain (0x00), and 4 empty payloads that the processor runs as Create.
  assert.deepEqual([...names.entries()].sort(), [
    ['Create', 63 + 4], ['CreateIdempotent', 1343],
  ]);
});

test('a tampered ARTIFACT refuses the load (decode comes from the derivation)', async () => {
  const dir = copyRepo();
  try {
    const file = path.join(dir, 'interface', `ata-${ATA}.json`);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Rename RecoverNested to Create: a wrong name for real money movement.
    doc.instructions.find((ix) => ix.name === 'RecoverNested').name = 'Create';
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    await assert.rejects(loadFrom(dir), /refuses to load/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tampered VENDORED SOURCE refuses the load (the claimed hash)', async () => {
  const dir = copyRepo();
  try {
    const file = path.join(dir, 'vendor', 'spl-associated-token-account',
      'fbf5379e7398ac8b231c73ee8a9ff677b43dd0ec', 'program', 'src', 'processor.rs');
    fs.appendFileSync(file, '\n// tampered: an extra branch in the processor\n');
    await assert.rejects(loadFrom(dir), /refuses to load|does not equal a fresh derivation/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a MISSING vendored source refuses the load', async () => {
  const dir = copyRepo();
  try {
    fs.rmSync(path.join(dir, 'vendor', 'spl-associated-token-account'), { recursive: true, force: true });
    await assert.rejects(loadFrom(dir), /not found|ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Guards: the only tests expected to pass on the pre-table tree. ----

test('G1: the ATA program stays OUT of the token table', async () => {
  const { isTokenProgram, tokenPrograms } = await import(path.join(ROOT, 'src', 'token.mjs'));
  assert.equal(isTokenProgram(ATA), false, 'ATA is its own pinned table, not a token program');
  assert.ok(!tokenPrograms().includes(ATA));
});

test('G2: a real measured SPL Token payload keeps decoding through the token table', async () => {
  const { decodeTokenInstruction } = await import(path.join(ROOT, 'src', 'token.mjs'));
  const sample = JSON.parse(await readFile(SAMPLE, 'utf8'));
  const row = sample.transactions
    .flatMap((tx) => tx.payloads)
    .find((payload) => payload.program === SPL_TOKEN && payload.dataHex === '01');
  assert.ok(row, 'the fixture must still carry SPL Token payloads');
  const decoded = decodeTokenInstruction(SPL_TOKEN, Buffer.from(row.dataHex, 'hex'), { trailing: 'report' });
  assert.equal(decoded.name, 'InitializeAccount');
  assert.equal(decoded.roundTripByteExact, true);
});
