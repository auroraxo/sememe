// Pins for the manifest second-source measurement (12.11., Stand-up-Puls):
//   research/manifest-second-source-2026-11-12.json
//
// WHAT THE MEASUREMENT FOUND (the point of pinning it):
//
//   research/ecosystem-coverage-2026-11-11.json lists MNFSTqtC9… (manifest)
//   as the acquisition queue's FIRST and largest entry: 307 payloads, 0
//   decoded, 307 no-interface, acquirable:false ("no on-chain IDL at either
//   address"). The card says: GPL-3.0 → vendor refused, adopt-and-measure.
//
//   1. The program's OWN generated wire table — Bonasa-Tech/manifest (the
//      annotated successor of CKS-Systems/manifest, the repo this program's
//      research had already cited as its upstream; GPL-3.0 LICENSE at the
//      pin) fuzz/crucible/idls/manifest.json @ d4e908b3… — closes ALL 307
//      committed payload bytes through ONE adopt on the product write path:
//      307 decoded / 0 refused / 307 byte-exact, names per discriminant
//      Deposit 46, Withdraw 46, Swap 3, BatchUpdate 201, GlobalWithdraw 1,
//      SwapV2 10.
//   2. The SAME repo's client/idl/manifest.json at the SAME commit is
//      DEFECT: it lists "Swap" (4) AND "SwapV2" (4) on one discriminator.
//      Adopted into a second throwaway store the product refuses all 307
//      payloads by name (`duplicate instruction discriminator 04 (Swap /
//      SwapV2)`). The defect face is measured against the upstream's own
//      bytes, not a synthetic fixture — an adopt-and-measure area that only
//      ever shows the sunny path would have trusted a table that matches no
//      wire.
//   3. GPL-3.0 at every pin: neither copy is vendored into this MIT repo or
//      the npm package. The committed store is byte-untouched
//      (`committedStoreModified: false`, readdir before/after in the tool).
//      The headline therefore stays 88.5% on the shipped store; a user who
//      adopts the pinned copy gets the closing (receipt `slot: null`,
//      origin declared).
//
// THE INVARIANTS below pin the committed numbers; the falsification half
// lives in the tool (NO VERDICT when the baseline stops reproducing the
// ecosystem artifact, when the sample's wire face moves, when the pin hash
// of EITHER copy disagrees, when the claimed duplicate vanishes from the
// client copy, when the union does not close byte-exactly, or when the
// committed store gains a file).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-manifest-second-source.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'manifest-second-source-2026-11-12.json');
const COVERAGE = path.join(ROOT, 'research', 'ecosystem-coverage-2026-11-11.json');
const MANIFEST = 'MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms';
const REPO = 'Bonasa-Tech/manifest';
const COMMIT = 'd4e908b34f7a050d63cad38cb7175b2e88008465';
const WIRE_FILE = 'fuzz/crucible/idls/manifest.json';
const CLIENT_FILE = 'client/idl/manifest.json';

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

test('the committed store holds NO manifest interface (the acquisition face the tool measured)', () => {
  const receipts = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11', 'receipts');
  const names = existsSync(receipts)
    ? readdirSync(receipts).filter((n) => n.startsWith(MANIFEST))
    : [];
  assert.deepEqual(names, [], 'the committed store must not carry a manifest receipt');
});

test('the ecosystem artifact\'s manifest face is the measurement\'s own baseline (no hand-edited numbers)', () => {
  const coverage = JSON.parse(readFileSync(COVERAGE, 'utf8'));
  const entry = coverage.programs.find((p) => p.program === MANIFEST);
  assert.equal(m.baseline.decoded, entry.decoded);
  assert.equal(m.baseline.noInterface, entry.noInterface);
  assert.equal(m.payloads, entry.payloads);
  // and the artifact agrees with itself: acquisition queue names the same face
  const queued = coverage.acquisitionQueue.find((q) => q.program === MANIFEST);
  assert.equal(queued.payloads, entry.payloads);
  assert.equal(queued.acquirable, false);
});

test('the baseline face is the pinned wire table, measured independently', () => {
  assert.deepEqual(artifact.face.map((f) => [f.discriminator, f.name, f.count]), [
    ['02', 'Deposit', 46],
    ['03', 'Withdraw', 46],
    ['04', 'Swap', 3],
    ['06', 'BatchUpdate', 201],
    ['0a', 'GlobalWithdraw', 1],
    ['0d', 'SwapV2', 10],
  ]);
  assert.equal(artifact.face.reduce((s, f) => s + f.count, 0), m.payloads);
  assert.equal(artifact.gates.faceMatchesPinnedWire, true);
});

test('the union closes all 307 payloads byte-exactly, names per discriminant', () => {
  assert.equal(m.union.decoded, 307);
  assert.equal(m.union.refused, 0);
  assert.equal(m.union.noInterface, 0);
  assert.equal(m.union.byteExact, 307);
  assert.equal(m.delta.decoded, 307);
  assert.equal(m.delta.refusalsClosed, 307);
  assert.equal(m.union.coveredPct, 100);
  assert.deepEqual(m.union.names, {
    Deposit: 46, Withdraw: 46, Swap: 3, BatchUpdate: 201, GlobalWithdraw: 1, SwapV2: 10,
  });
  // the evidence class stays apart: there is no pull, only the adopted copy
  assert.equal(m.union.adoptedAnswered, 307);
  assert.equal(m.union.pulledAnswered, 0);
  assert.equal(artifact.gates.unionFullyCloses, true);
  assert.equal(artifact.gates.namesMatchFace, true);
});

test('the defect face is the upstream\'s own client copy, refused by name', () => {
  const client = artifact.pin.clientCopy;
  assert.equal(client.duplicatedDiscriminator, '04');
  assert.deepEqual(client.duplicatedNames, ['Swap', 'SwapV2']);
  assert.equal(m.defect.decoded, 0);
  assert.equal(m.defect.refused, 307);
  assert.equal(m.defect.duplicateRefusals, 307);
  assert.equal(m.defect.refusalNamed, 'duplicate instruction discriminator 04 (Swap / SwapV2)');
  assert.equal(artifact.gates.defectRefusesByName, true);
  // the wire-table copy the pin allows must NOT carry it
  assert.equal(artifact.pin.wireTable.instructionCount, 15);
  assert.equal(artifact.pin.clientCopy.instructionCount, 16);
});

test('the adopted receipt can never claim a slot, and the store stays byte-untouched', () => {
  assert.equal(artifact.receipt.slot, null);
  assert.equal(artifact.receipt.originStatus, 'declared');
  assert.equal(artifact.gates.receiptSlotNull, true);
  assert.equal(artifact.committedStoreModified, false);
  assert.equal(artifact.gates.committedStoreUntouched, true);
  assert.equal(existsSync(path.join(ROOT, 'vendor', 'manifest')), false,
    'GPL-3.0 bytes must never be vendored into this repository');
});

test('the licensing gate records GPL-3.0 and keeps the bytes out', () => {
  assert.equal(artifact.pin.license, 'GPL-3.0');
  assert.match(artifact.pin.licenseNote, /stay OUT of this repository/);
  // only fingerprints of the copies are committed, never the bytes
  assert.match(artifact.pin.wireTable.canonicalFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(artifact.pin.clientCopy.canonicalFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('no host path leaks into the committed artifact', () => {
  const text = JSON.stringify(artifact);
  assert.equal(text.includes('/home/'), false);
  assert.equal(text.includes('/tmp/'), false);
  assert.equal(text.includes('research/.manifest-'), false);
});

test('FALSIFIED: tampered source bytes refuse with NO VERDICT before any measurement', async (t) => {
  if (!(await ghAuthed())) {
    t.skip('gh not authenticated; the license gate needs a live fetch of the GPL bytes');
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'sememe-manifest-pin-'));
  try {
    const wire = await fetchAt(WIRE_FILE);
    const client = await fetchAt(CLIENT_FILE);
    // a hand-truncated copy of the wire table: the pin gate must refuse it
    const tampered = JSON.parse(wire);
    tampered.instructions = tampered.instructions.slice(0, 8);
    await writeFile(path.join(dir, 'tampered.json'), JSON.stringify(tampered));
    await writeFile(path.join(dir, 'wire.json'), wire);
    await writeFile(path.join(dir, 'client.json'), client);

    let code = 0; let stderr = '';
    try {
      await run(process.execPath, [TOOL,
        '--source', path.join(dir, 'tampered.json'),
        '--client-source', path.join(dir, 'client.json'),
        '--out', path.join(dir, 'out.json')], { cwd: ROOT, timeout: 120000 });
    } catch (error) {
      code = error.code ?? error.status;
      stderr = String(error.stderr ?? '');
    }
    assert.equal(code, 3, 'the pin check must refuse tampered bytes with exit 3');
    assert.match(stderr, /manifest-pin-hash-mismatch/);
    assert.match(stderr, /NO VERDICT/);
    assert.equal(existsSync(path.join(dir, 'out.json')), false,
      'a refused measurement must write no artifact');
  } finally {
    await rm(dir, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
  }
});

test('the committed artifact is what the tool derives from the pinned commits', async (t) => {
  if (!(await ghAuthed())) {
    t.skip('gh not authenticated; the re-derivation needs a live fetch of the GPL bytes');
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'sememe-manifest-'));
  const out = path.join(dir, 'fresh.json');
  try {
    await writeFile(path.join(dir, 'wire.json'), await fetchAt(WIRE_FILE));
    await writeFile(path.join(dir, 'client.json'), await fetchAt(CLIENT_FILE));
    await run(process.execPath, [TOOL,
      '--source', path.join(dir, 'wire.json'),
      '--client-source', path.join(dir, 'client.json'),
      '--out', out], { cwd: ROOT, timeout: 300000 });
    const produced = JSON.parse(await readFile(out, 'utf8'));
    const strip = (r) => { const c = { ...r }; delete c.generatedAt; return c; };
    assert.deepEqual(strip(produced), strip(artifact),
      'the committed artifact is not what the tool derives — re-run the tool and commit its output');
  } finally {
    await rm(dir, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
  }
});
