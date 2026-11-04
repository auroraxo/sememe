import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const { decodeInstructionData, encodeInstructionData, instructionIndex } =
  await import('../src/codec.mjs');
const { withDerivedDiscriminators } = await import('../src/discriminators.mjs');
const { decodePayload } = await import('../src/decode.mjs');
const { adopt } = await import('../src/adopt.mjs');

const LH = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const IDL_PATH = path.join(ROOT, 'test', 'fixtures', 'shank-lighthouse-2026-11-04', 'lighthouse.json');

// Zero-dep base58 (test-only)
const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decodeBase58(s) {
  let n = 0n;
  for (const c of s) {
    const idx = ALPH.indexOf(c);
    if (idx < 0) throw Error('bad base58');
    n = n * 58n + BigInt(idx);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

const FOREIGN_REPO = process.env.SEMEME_STEP_INGESTOOR_PATH
  ?? (process.env.GITHUB_WORKSPACE
    ? path.join(process.env.GITHUB_WORKSPACE, 'step-ingestooor')
    : path.join(os.homedir(), 'github_repos', 'step-ingestooor'));
const FIXTURES_DIR = path.join(FOREIGN_REPO, 'crates', 'parsers', 'tests');
const hasForeignRepo = existsSync(FIXTURES_DIR);

function* jsonFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonFiles(full);
    else if (entry.name.endsWith('.json')) yield full;
  }
}

function walk(o, out) {
  if (o && typeof o === 'object') {
    if (o.programId === LH && typeof o.data === 'string') out.push(o.data);
    for (const v of Object.values(o)) walk(v, out);
  }
}

// --- Minimal shank-shaped IDL (mirrors the lighthouse pattern) --------------
const MINIMAL_SHANK_IDL = {
  version: '1.0.0',
  name: 'shank_example',
  metadata: { origin: 'shank', address: LH },
  instructions: [
    {
      name: 'WriteByte',
      discriminant: { type: 'u8', value: 0 },
      args: [{ name: 'value', type: 'u8' }],
    },
    {
      name: 'WriteCompact',
      discriminant: { type: 'u8', value: 6 },
      args: [
        { name: 'offset', type: { defined: 'CompactU64' } },
        { name: 'bytes', type: { defined: 'CompactBytes' } },
      ],
    },
  ],
  types: [],
};

// --- Falsification ladder ---------------------------------------------------
//   - pre-fix: T1-T5 RED (shank discriminant discarded / Anchor sighash
//     invented for a 1-byte selector / LEB128 types unknown),
//   - T6 FALSE-POSITIVE GUARD: Anchor 8-byte sighashes fill and decode
//     identically on both trees.

test('T1: withDerivedDiscriminators copies 1-byte shank discriminants verbatim, never a sighash', () => {
  const { idl, filled, conflicts } = withDerivedDiscriminators(MINIMAL_SHANK_IDL);
  assert.equal(filled.instructions, 0, 'shank discriminants must NOT be counted as Anchor derivations');
  assert.equal(conflicts.length, 0);
  assert.deepEqual(idl.instructions[0].discriminator, [0]);
  assert.deepEqual(idl.instructions[1].discriminator, [6]);
});

test('T2: instructionIndex indexes 1-byte discriminators and matches them', () => {
  const { idl } = withDerivedDiscriminators(MINIMAL_SHANK_IDL);
  const index = instructionIndex(idl);
  assert.equal(index.has('00'), true);
  assert.equal(index.has('06'), true);
  assert.equal(index.get('06').name, 'WriteCompact');
});

test('T3: decodeInstructionData decodes and re-encodes a 1-byte shank payload byte-exactly', () => {
  const { idl } = withDerivedDiscriminators(MINIMAL_SHANK_IDL);
  const raw = Buffer.from([0x00, 0x42]);
  const decoded = decodeInstructionData(idl, raw);
  assert.equal(decoded.instruction, 'WriteByte');
  assert.equal(decoded.discriminator, '00');
  assert.deepEqual(decoded.args, { value: 66 });
  assert.equal(decoded.consumed, 2);
  const enc = encodeInstructionData(idl, decoded.instruction, decoded.args);
  assert.deepEqual(enc, raw);
});

test('T4: LEB128 types CompactU64 and CompactBytes round-trip byte-exactly', () => {
  const { idl } = withDerivedDiscriminators(MINIMAL_SHANK_IDL);
  const raw = Buffer.from([0x06, 0xe5, 0x8e, 0x26, 0x03, 0xaa, 0xbb, 0xcc]);
  const decoded = decodeInstructionData(idl, raw);
  assert.equal(decoded.instruction, 'WriteCompact');
  assert.equal(decoded.discriminator, '06');
  assert.equal(decoded.args.offset, 624485);
  assert.deepEqual(decoded.args.bytes, [0xaa, 0xbb, 0xcc]);
  assert.equal(decoded.consumed, raw.length);
  const enc = encodeInstructionData(idl, decoded.instruction, decoded.args);
  assert.deepEqual(enc, raw);
});

test('T5: real foreign fixture payload (selector 6, AssertAccountInfoMulti) decodes from full first-party IDL', async () => {
  const idlRaw = JSON.parse(await readFile(IDL_PATH, 'utf8'));
  const { idl } = withDerivedDiscriminators(idlRaw);
  const raw = Buffer.from('0605020053bb50160000000004030000', 'hex');
  const decoded = decodeInstructionData(idl, raw);
  assert.equal(decoded.instruction, 'AssertAccountInfoMulti');
  assert.equal(decoded.discriminator, '06');
  assert.equal(decoded.consumed, 16);
  const enc = encodeInstructionData(idl, decoded.instruction, decoded.args);
  assert.deepEqual(enc, raw);
});

test('T6 (FALSE-POSITIVE GUARD): Anchor 8-byte sighashes still fill and decode unchanged on any tree', () => {
  const anchorIdl = {
    version: '0.1.0',
    name: 'anchor_example',
    instructions: [{ name: 'initialize', args: [] }],
  };
  const { idl, filled } = withDerivedDiscriminators(anchorIdl);
  assert.equal(filled.instructions, 1);
  assert.equal(idl.instructions[0].discriminator.length, 8);
  const raw = Buffer.from(idl.instructions[0].discriminator);
  const decoded = decodeInstructionData(idl, raw);
  assert.equal(decoded.instruction, 'initialize');
  assert.equal(decoded.consumed, 8);
});

test('T7: all 42 real foreign Lighthouse payloads decode byte-exactly from the published IDL', { skip: !hasForeignRepo && 'step-ingestooor clone not found (set SEMEME_STEP_INGESTOOR_PATH)' }, async () => {
  const idlRaw = JSON.parse(await readFile(IDL_PATH, 'utf8'));
  const { idl } = withDerivedDiscriminators(idlRaw);
  let count = 0;
  let byteExact = 0;
  const byInstruction = {};
  for (const file of jsonFiles(FIXTURES_DIR)) {
    let doc;
    try { doc = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
    const rows = [];
    walk(doc, rows);
    for (const data of rows) {
      count++;
      const raw = decodeBase58(data);
      const decoded = decodeInstructionData(idl, raw);
      byInstruction[decoded.instruction] = (byInstruction[decoded.instruction] ?? 0) + 1;
      const enc = encodeInstructionData(idl, decoded.instruction, decoded.args);
      assert.deepEqual(enc, raw, `${decoded.instruction} must re-encode byte-exactly`);
      byteExact++;
    }
  }
  assert.equal(count, 42, 'the foreign fixtures hold exactly 42 Lighthouse payloads');
  assert.equal(byteExact, 42, 'all 42 payloads must decode byte-exactly');
  assert.deepEqual(byInstruction, {
    AssertAccountInfoMulti: 21,
    AssertTokenAccountMulti: 21,
  }, 'all 42 payloads are the two multi assertions');
});

test('T9 (FALSE-POSITIVE GUARD): the LEB128 hook never engages for an Anchor IDL', () => {
  // A shank-named type in an ANCHOR IDL is still an undefined type: the
  // length dialect belongs to the IDL, not to the string. This is the guard
  // against the hook leaking into Anchor decodes.
  const anchorIdl = {
    version: '0.1.0',
    name: 'anchor_same_name',
    metadata: { origin: 'anchor' },
    instructions: [{ name: 'write', args: [{ name: 'offset', type: { defined: 'CompactU64' } }] }],
  };
  const { idl } = withDerivedDiscriminators(anchorIdl);
  const prefix = Buffer.from(idl.instructions[0].discriminator);
  assert.throws(
    () => decodeInstructionData(idl, Buffer.concat([prefix, Buffer.from([0x05])])),
    /unknown defined type "CompactU64"/,
    'an Anchor IDL must refuse an undefined shank-named type, not decode LEB128');
});

test('T8: sememe adopt stores the shank IDL and decodePayload answers through the store', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-lh-adopt-'));
  try {
    const receipt = await adopt(LH, IDL_PATH, tmp, { source: 'first-party', origin: 'Jac0xb/lighthouse' });
    assert.equal(receipt.program, LH);
    assert.equal(receipt.source, 'first-party');
    assert.equal(receipt.instructionCount, 18);
    const decoded = await decodePayload(tmp, LH, '0605020053bb50160000000004030000');
    assert.equal(decoded.instruction, 'AssertAccountInfoMulti');
    assert.equal(decoded.discriminator, '06');
    assert.equal(decoded.roundTripByteExact, true);
    assert.equal(decoded.idl.source, 'first-party');
    assert.equal(decoded.idl.slot, null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
