// Pins for the archer second-source measurement (12.11. Stand-up-Puls):
//   research/archer-second-source-2026-11-12.json
//
// WHAT THE MEASUREMENT FOUND (the point of pinning it):
//
//   research/ecosystem-coverage-2026-11-11.json lists Archer8kgiav… as an
//   entry in the acquisition queue: 83 payloads, 0 decoded, 83 no-interface,
//   acquirable:false ("no on-chain IDL at either address").
//
//   1. The program's OWN SDK — ballista-tech/archer-sdk (Apache-2.0, the crate
//      that declares ARCHER_V1_PROGRAM_ID = pubkey!("Archer8kgiavM61Gyus…") in
//      src/lib.rs) idl/archer_v1.json @ 5d07c895… — closes 82 of the 83
//      committed payload bytes through ONE adopt on the product write path:
//      82 decoded / 1 refused / 0 no-interface / 82 byte-exact. Names per
//      shank discriminant: UpdateMidPrice 78, UpdateBook 3, ClearBook 1.
//   2. The single remaining refusal is the interface's OWN DOCUMENTED LEGACY
//      FORM: SwapParams docstring says "Borsh args for Swap and
//      SwapFromArcherAccount, 22 bytes. The program also accepts an 18-byte
//      payload that stops after mode … read as a 0 fee", and the on-chain
//      witness payload is exactly 19 bytes (1 tag + 18 args). sememe refuses
//      it with `truncated input` because the absent-field policy operates on
//      top-level instruction arguments, not fields inside a defined struct.
//      The measurement pins the refusal name and byte offset rather than
//      guessing it decodes.
//   3. Apache-2.0 at the pin: the file is read at the pin outside the repo
//      and adopted into a throwaway store. The committed store is byte-untouched
//      (`committedStoreModified: false`, readdir before/after in the tool).
//
// THE INVARIANTS below pin the committed numbers; the falsification half
// lives in the tool (NO VERDICT when the baseline stops reproducing the
// ecosystem artifact, when the sample's wire face moves, when the pin hash
// disagrees, when the dialect is not shank, or when the committed store gains
// a file).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const run = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-archer-second-source.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'archer-second-source-2026-11-12.json');
const COVERAGE = path.join(ROOT, 'research', 'ecosystem-coverage-2026-11-11.json');
const ARCHER = 'Archer8kgiavM61GyusMzaaS2ft5sALtNsD1HxkUPMhy';
const REPO = 'ballista-tech/archer-sdk';
const COMMIT = '5d07c895207ebd02f1ce70078b2d0c1ec3f186b5';
const IDL_FILE = 'idl/archer_v1.json';

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));
const m = artifact.measured;

async function ghAuthed() {
  try { await run('gh', ['auth', 'status'], { timeout: 15000 }); return true; }
  catch { return false; }
}

async function fetchAt(file, ref = COMMIT) {
  const res = await run('gh', ['api',
    `repos/${REPO}/contents/${file}?ref=${ref}`,
    '-H', 'Accept: application/vnd.github.raw'], { timeout: 60000, maxBuffer: 8 << 20 });
  return res.stdout;
}

test('the committed store holds NO archer interface (the acquisition face the tool measured)', () => {
  const receipts = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11', 'receipts');
  const names = existsSync(receipts)
    ? readdirSync(receipts).filter((n) => n.startsWith(ARCHER))
    : [];
  assert.deepEqual(names, [], 'the committed store must not carry an archer receipt');
});

test('the ecosystem artifact\'s archer face is the measurement\'s own baseline (no hand-edited numbers)', () => {
  const coverage = JSON.parse(readFileSync(COVERAGE, 'utf8'));
  const entry = coverage.programs.find((p) => p.program === ARCHER);
  assert.equal(m.baseline.decoded, entry.decoded);
  assert.equal(m.baseline.noInterface, entry.noInterface);
  assert.equal(m.payloads, entry.payloads);
  const queued = coverage.acquisitionQueue.find((q) => q.program === ARCHER);
  assert.equal(queued.payloads, entry.payloads);
  assert.equal(queued.acquirable, false);
});

test('the baseline face is the pinned wire table, measured independently', () => {
  assert.deepEqual(artifact.face.map((f) => [f.tag, f.name, f.length, f.count]), [
    ['07', 'UpdateBook', 536, 3],
    ['08', 'UpdateMidPrice', 17, 78],
    ['09', 'ClearBook', 9, 1],
    ['0f', 'Swap', 19, 1],
  ]);
  assert.equal(artifact.face.reduce((s, f) => s + f.count, 0), m.payloads);
  assert.equal(artifact.gates.faceMatchesPinnedWire, true);
});

test('the union closes 82 of 83 payloads byte-exactly, names per discriminant', () => {
  assert.equal(m.union.decoded, 82);
  assert.equal(m.union.refused, 1);
  assert.equal(m.union.noInterface, 0);
  assert.equal(m.union.byteExact, 82);
  assert.equal(artifact.delta.decoded, 82);
  assert.equal(artifact.delta.refusalsClosed, 82);
  assert.equal(artifact.delta.coveredPct, 98.8);
  assert.deepEqual(m.union.names, {
    UpdateMidPrice: 78, UpdateBook: 3, ClearBook: 1,
  });
  assert.equal(m.union.adoptedAnswered, 82);
  assert.equal(m.union.pulledAnswered, 0);
});

test('the legacy Swap form stays a named refusal at the expected byte offset', () => {
  assert.equal(m.legacySwapRefusalCount, 1);
  assert.match(String(m.legacySwapRefusal), /truncated input.*need 4 byte/);
  assert.equal(artifact.gates.legacySwapStaysRefused, true);
});

test('the receipt is content-addressed, slot null, and origin declared', () => {
  assert.equal(m.receipt.slot, null);
  assert.equal(m.receipt.originStatus, 'declared');
  assert.match(m.receipt.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(m.receipt.instructionCount, 27);
  assert.equal(artifact.gates.receiptSlotNull, true);
  assert.equal(artifact.gates.receiptOriginDeclared, true);
});

test('the committed store was not modified during measurement', () => {
  assert.equal(m.committedStoreModified, false);
  assert.equal(artifact.gates.committedStoreUntouched, true);
});

test('all artifact gates are green and verdict is measured', () => {
  assert.equal(artifact.verdict, 'measured');
  assert.equal(Object.values(artifact.gates).every(Boolean), true);
});

test('pin network test: re-fetching the upstream IDL at the pin produces the exact canonical fingerprint', async (t) => {
  if (!await ghAuthed()) {
    t.skip('gh CLI not authenticated; skipping network re-fetch');
    return;
  }
  const raw = await fetchAt(IDL_FILE, COMMIT);
  const parsed = JSON.parse(raw);
  const { canonicalJson } = await import('../src/canonical.mjs');
  const { createHash } = await import('node:crypto');
  const canon = canonicalJson(parsed);
  const hash = createHash('sha256').update(Buffer.from(canon + '\n')).digest('hex');
  assert.equal(hash, artifact.pin.canonicalFingerprint, 'canonical fingerprint at the pin must match the artifact exactly');
});

test('tool falsification: a source whose bytes do not match the pin exits 3 with NO VERDICT', async () => {
  // Any JSON that is NOT the pinned copy must trip the fingerprint gate
  // BEFORE any store write — a hand-edited name is the cheapest witness.
  const scratch = path.join(ROOT, 'research', `.tamper-archer-test-${process.pid}.json`);
  const { writeFile, rm } = await import('node:fs/promises');
  try {
    await writeFile(scratch, JSON.stringify({
      name: 'archer_v1',
      version: '0.1.0',
      instructions: [{ name: 'InitializeMarketTampered', discriminant: { type: 'u8', value: 0 }, args: [], accounts: [] }],
      types: [],
      metadata: { address: ARCHER, origin: 'shank' },
    }));
    await assert.rejects(
      run('node', [TOOL, '--source', scratch]),
      (err) => err.code === 3 && /archer-pin-hash-mismatch/.test(err.stderr),
      'the pin gate must refuse bytes nobody reviewed',
    );
  } finally {
    await rm(scratch, { force: true });
  }
});

test('tool falsification: the pinned copy with one edited byte still exits 3', async () => {
  const scratch = path.join(ROOT, 'research', `.edit-archer-test-${process.pid}.json`);
  const { writeFile, rm } = await import('node:fs/promises');
  try {
    await writeFile(scratch, JSON.stringify({
      // a copy that parses but is not the pinned interface: the gate keys on
      // the CANONICAL hash, so any deviation — even an emptied instruction
      // list — refuses instead of measuring a different premise.
      name: 'archer_v1',
      version: '0.1.0',
      instructions: [],
      types: [],
      metadata: { address: ARCHER, origin: 'shank' },
    }));
    await assert.rejects(
      run('node', [TOOL, '--source', scratch]),
      (err) => err.code === 3,
      'an empty interface is not the pinned copy',
    );
  } finally {
    await rm(scratch, { force: true });
  }
});
