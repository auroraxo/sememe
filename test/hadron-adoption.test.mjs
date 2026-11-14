// HADRo acquisition: the one measured case where sememe's ON-CHAIN interface
// copy is complete on instructions and types but INCOMPLETE ON THE WIRE —
// closed through the PRODUCT's own write path with a HASH-VERIFIED vendored
// first-party copy. Measured, not typed.
//
//   BEFUND (research/hadron-adoption-2026-11-14.json): the on-chain metadata
//   IDL (slot 468262003) declares all 38 instructions and every type, and
//   lacks EXACTLY TWO argument declarations — `sequence: u64` last on setCurve
//   and setRiskCurve. The wire carries those 8 bytes after the points, so from
//   the stored copy alone: 144/144 committed chain-accepted payloads decode,
//   144/144 end with 8 unexplained trailing bytes, 0/144 re-encode
//   byte-exactly, and 144/144 are refused under `--trailing error`.
//
//   THE FOUR-FACE LADDER (same 144 payloads in every face, identified by the
//   discriminator byte 0x04/0x08 ONLY so no face's decoder selects another
//   face's rows):
//
//     F1 prefix tree ea074c4 + stored IDL      72 decoded / 72 refused / 0 exact
//     F2 prefix tree ea074c4 + first-party     72 decoded / 72 refused / 0 exact
//     F3 current tree    + stored IDL         144 decoded /  0 refused / 0 exact
//     F4 current tree    + first-party        144 decoded /  0 refused / 144 exact
//
//   F2 is the falsifier for "just adopt the source IDL": the first-party copy
//   declares `points` as a Borsh vec TOO, so without count-from-header it
//   refuses the same 72 payloads and reproduces 0 bytes byte-exactly. F3 alone
//   falsifies "the header rule alone is the fix": it stops the refusals but
//   drops the 8-byte tail, so 0/144 still round-trip. Only F4 — both fixes
//   composed — reproduces every byte of all 144 payloads.
//
// THE LADDER (L1..L7 RED against the tree WITHOUT vendor/hadron,
// src/hadron.mjs and the `adopt-hadron` command; the module import is lazy so
// the FILE loads on the pre-fix tree and the guards there stay distinguishable):
//   L1 the vendored copy loads: 38 instructions, address = the pin's program,
//      and BOTH `sequence:u64` tail args present and last;
//   L2 a doctored vendored byte stream REFUSES by name (hash mismatch);
//   L3 a missing vendor file REFUSES by name;
//   L4 a vendored file declaring ANOTHER program's address REFUSES by name;
//   L5 a copy that lost one `sequence:u64` tail REFUSES by name — the pin
//      covers BYTES, this check covers the CLAIM the bytes make;
//   L6 ADOPTING through src/adopt.mjs makes the union reproduce all 144
//      payloads byte-exactly with 0 trailing bytes, where the same store
//      BEFORE the adoption reproduced 0 and refused all 144 under strict
//      mode (the measured gap, reproduced in-test);
//   L7 the `adopt-hadron` CLI command exists, exits 0, and its help text
//      carries the command.
//
//   G1/G2 are the guards, green on BOTH trees: the fixture still holds the
//   measured 144 payloads, and adopt still refuses an interface file that
//   declares a DIFFERENT program (a product rule that predates this fix).
//
// Falsification contract: loadVendoredHadron runs BEFORE any write, so a
// tampered, missing or tail-less vendor file means NOTHING was written to the
// store — the refusal names the face instead of adopting bytes nobody
// reviewed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);
const importRepo = (rel) => import(path.join(ROOT, rel));

// Lazy so the FILE loads on the pre-fix tree: a missing module must turn each
// L-face red individually, not crash the run before G1/G2 can run green.
const hadron = await importRepo('src/hadron.mjs').catch(() => null);
const PROGRAM = 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8';
const { adopt } = await importRepo('src/adopt.mjs');
const { decodeUnionPayload } = await importRepo('src/decode.mjs');

const STORE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11');
const SAMPLE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json');
const VENDOR_DIR = () => path.join(ROOT, 'vendor', 'hadron', hadron?.HADRON_PIN?.commit ?? 'unknown');

// 144 committed chain-accepted payloads, selected by DISCRIMINATOR BYTE ONLY —
// the same codec-independent selector the measurement tool uses, so this test
// cannot quietly measure a different row set than the artifact.
function measuredPayloads() {
  const sample = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  const rows = [];
  for (const tx of Object.values(sample.transactions ?? {})) {
    for (const payload of tx.payloads ?? []) {
      if (payload.program === PROGRAM && ['04', '08'].includes(String(payload.dataHex).slice(0, 2))) {
        rows.push(payload.dataHex);
      }
    }
  }
  return rows;
}
const PAYLOADS = measuredPayloads();

function cli(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'sememe.mjs'), ...args], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** A scratch store holding the COMMITTED store's contents. */
function scratchStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sememe-hadron-test-'));
  const { cpSync } = require('node:fs');
  cpSync(STORE, dir, { recursive: true });
  return dir;
}

/**
 * A scratch REPO ROOT laid out exactly like the real one —
 * `<root>/vendor/hadron/<commit>/<file>` — so a tampered copy is loaded by the
 * same path arithmetic the product uses. Writing the doctored file directly
 * into a temp dir would trip `hadron-vendor-missing` on path shape instead of
 * the face the test is actually trying to provoke.
 */
function scratchVendorRoot(withFile) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sememe-hadron-root-'));
  const dir = path.join(root, 'vendor', 'hadron', hadron.HADRON_PIN.commit);
  require('node:fs').mkdirSync(dir, { recursive: true });
  if (withFile) withFile(dir);
  return root;
}


/** assert.throws does NOT return the error; this captures it so the message
 * can be asserted on too (the refusal NAME is the contract here). */
function refusal(fn, pattern) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected a refusal matching ${pattern}`);
  assert.match(caught.message, pattern);
  return caught;
}

// --- guards (green on both trees) -----------------------------------------

test('G1 the fixture still carries exactly the measured 144 payloads', () => {
  assert.equal(PAYLOADS.length, 144,
    'the committed sample moved — the whole artifact and this ladder are pinned to 144');
});

test('G2 adopt still refuses an interface file that declares a different program', async (t) => {
  const foreign = path.join(os.tmpdir(), `sememe-hadron-foreign-${Date.now()}.json`);
  const idl = JSON.parse(readFileSync(path.join(ROOT, 'test', 'fixtures', 'cp-amm-idl.json'), 'utf8'));
  writeFileSync(foreign, JSON.stringify(idl));
  t.after(() => rmSync(foreign, { force: true }));
  const store = scratchStore();
  t.after(() => rmSync(store, { recursive: true, force: true }));
  await assert.rejects(() => adopt(PROGRAM, foreign, store, { source: 'published', origin: 'test' }),
    /declares|address/i, 'adopt must refuse a re-labelling, a rule that predates this fix');
});

// --- the ladder -----------------------------------------------------------

test('L1 the vendored copy loads, binds the program, and declares both tail args', (t) => {
  assert.ok(hadron, 'src/hadron.mjs must exist');
  const loaded = hadron.loadVendoredHadron();
  assert.equal(loaded.idl.instructions.length, 38, 'the first-party copy carries all 38 instructions');
  assert.equal(loaded.idl.address, PROGRAM, 'the vendored file binds the program by its own address');
  assert.equal(loaded.declaredMissing.length, 2, 'both sequence:u64 tails must be declared and last');
  const byName = new Map(loaded.idl.instructions.map((ix) => [ix.name, ix]));
  for (const expected of hadron.HADRON_MISSING_ARGS) {
    const last = byName.get(expected.instruction).args.at(-1);
    assert.deepEqual({ name: last.name, type: last.type },
      { name: expected.arg, type: expected.type },
      `${expected.instruction} must end with ${expected.arg}:${expected.type}`);
  }
  // The pin covers every vendored file, not just the IDL.
  for (const file of hadron.HADRON_PIN.files) {
    const onDisk = path.join(VENDOR_DIR(), path.basename(file.file));
    assert.ok(existsSync(onDisk), `${file.file} must be vendored`);
    assert.equal(createHash('sha256').update(readFileSync(onDisk)).digest('hex'), file.sha256,
      `${file.file} must match its pinned sha256`);
  }
  t.diagnostic(`vendored commit ${hadron.HADRON_PIN.commit} (${hadron.HADRON_PIN.license})`);
});

test('L2 a doctored vendored byte stream refuses by name', (t) => {
  const raw = readFileSync(path.join(VENDOR_DIR(), 'hadron.json'), 'utf8');
  const root = scratchVendorRoot((dir) => writeFileSync(path.join(dir, 'hadron.json'), raw.replace('"name"', '"namE"')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const error = refusal(() => hadron.loadVendoredHadron(root, {
    ...hadron.HADRON_PIN,
    files: [{ ...hadron.HADRON_PIN.files[0], sha256: createHash('sha256').update(raw).digest('hex') }],
  }), /hadron-vendor-hash-mismatch/);
  assert.match(error.message, /refusing to adopt bytes that are not the reviewed copy/);
});

test('L3 a missing vendor file refuses by name', (t) => {
  const root = scratchVendorRoot(null);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const error = refusal(() => hadron.loadVendoredHadron(root), /hadron-vendor-missing/);
  assert.match(error.message, /is not present/);
});

test('L4 a copy declaring another program refuses by name — never re-labelled', (t) => {
  const idl = JSON.parse(readFileSync(path.join(VENDOR_DIR(), 'hadron.json'), 'utf8'));
  idl.address = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const bytes = Buffer.from(JSON.stringify(idl));
  const root = scratchVendorRoot((dir) => writeFileSync(path.join(dir, 'hadron.json'), bytes));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const error = refusal(() => hadron.loadVendoredHadron(root, {
    ...hadron.HADRON_PIN,
    files: [{ ...hadron.HADRON_PIN.files[0], sha256: createHash('sha256').update(bytes).digest('hex') }],
  }), /hadron-address-disagrees/);
  assert.match(error.message, /pin binds/);
});

test('L5 a copy that lost one sequence:u64 tail refuses by name', (t) => {
  const idl = JSON.parse(readFileSync(path.join(VENDOR_DIR(), 'hadron.json'), 'utf8'));
  const setCurve = idl.instructions.find((ix) => ix.name === 'setCurve');
  setCurve.args.pop(); // the bytes still hash correctly against the new pin —
  // that is exactly the point: a hash proves BYTES, this check proves the CLAIM.
  const bytes = Buffer.from(JSON.stringify(idl));
  const root = scratchVendorRoot((dir) => writeFileSync(path.join(dir, 'hadron.json'), bytes));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const error = refusal(() => hadron.loadVendoredHadron(root, {
    ...hadron.HADRON_PIN,
    files: [{ ...hadron.HADRON_PIN.files[0], sha256: createHash('sha256').update(bytes).digest('hex') }],
  }), /hadron-tail-args-absent/);
  assert.match(error.message, /would promise byte-exactness it cannot deliver/);
});

test('L6 adopting reproduces all 144 payloads byte-exactly; the same store before it did not', async (t) => {
  const store = scratchStore();
  t.after(() => rmSync(store, { recursive: true, force: true }));

  // BEFORE: the measured gap, through the product's own union path.
  let beforeExact = 0;
  let beforeStrict = 0;
  for (const hex of PAYLOADS) {
    const view = await decodeUnionPayload(store, PROGRAM, hex, { trailing: 'report' });
    if (view.roundTripByteExact) beforeExact += 1;
    try {
      await decodeUnionPayload(store, PROGRAM, hex, { trailing: 'error' });
    } catch { beforeStrict += 1; }
  }
  assert.equal(beforeExact, 0, 'before adoption NOTHING re-encodes byte-exactly');
  assert.equal(beforeStrict, 144, 'before adoption strict mode refuses all 144');

  // ADOPT through the product's one write path, pin checked first.
  const loaded = hadron.loadVendoredHadron();
  const receipt = await adopt(PROGRAM, loaded.path, store, {
    source: 'published',
    origin: hadron.hadronOriginLabel(),
  });
  assert.equal(receipt.source, 'published', 'the receipt says published, not on-chain');
  assert.equal(receipt.originStatus, 'declared', 'the origin stays declared — provenance of bytes');

  // AFTER.
  let afterExact = 0;
  let afterStrict = 0;
  let trailing = null;
  let driftPaths = null;
  for (const hex of PAYLOADS) {
    const view = await decodeUnionPayload(store, PROGRAM, hex, { trailing: 'report' });
    if (view.roundTripByteExact) afterExact += 1;
    trailing = view.trailing.count;
    driftPaths = view.view?.drift?.paths?.paths ?? driftPaths;
    try {
      await decodeUnionPayload(store, PROGRAM, hex, { trailing: 'error' });
    } catch { afterStrict += 1; }
  }
  assert.equal(afterExact, 144, 'after adoption ALL 144 payloads re-encode byte-exactly');
  assert.equal(afterStrict, 0, 'after adoption strict mode accepts all 144');
  assert.equal(trailing, 0, 'after adoption no payload carries unexplained bytes');
  assert.ok(driftPaths?.includes('sequence'),
    `the disagreement with the on-chain copy must be NAMED, got ${JSON.stringify(driftPaths)}`);
});

test("L7 the adopt-hadron command exists, runs, and is in the help text", async (t) => {
  const help = await cli('--help');
  assert.match(help.stdout + help.stderr, /adopt-hadron/,
    'the usage text must carry adopt-hadron');
  // Unknown-command help exits 2; make sure the spec knows the command too.
  const surface = await importRepo('src/cli-surface.mjs');
  assert.ok(surface.COMMAND_NAMES.includes('adopt-hadron'),
    'COMMAND_SPECS must list adopt-hadron (usage text alone would not validate its flags)');

  const store = scratchStore();
  t.after(() => rmSync(store, { recursive: true, force: true }));
  const adoptRun = await cli('adopt-hadron', '--store', store);
  assert.equal(adoptRun.code, 0, `adopt-hadron must exit 0: ${adoptRun.stderr.slice(0, 400)}`);
  const result = JSON.parse(adoptRun.stdout);
  assert.equal(result.program, PROGRAM);
  assert.equal(result.originStatus, 'declared');
  // adopt SANITIZES the origin into a filename-safe label (the `@` becomes a
  // dash) and caps it at 64 characters — silently truncating anything
  // longer. The label this module records is chosen to FIT, so the FULL
  // 40-hex commit survives: a truncated commit is not a commit.
  assert.match(result.origin, /hadron-tx-verifier-0c1bca1d8c9bc2abaa1b3d651d450c814cdd6328/,
    'the recorded origin must carry the WHOLE commit, not a truncated prefix');

  // Idempotent: adopting twice is not an error and not a second receipt face.
  const again = await cli('adopt-hadron', '--store', store);
  assert.equal(again.code, 0, `re-adopt must exit 0: ${again.stderr.slice(0, 300)}`);

  // The plain single-source read still answers from the ON-CHAIN receipt:
  // adoption widens what --union can arbitrate, it never silently rewrites
  // the default answer (the slot-0 ordering rule src/adopt.mjs measures).
  const plain = await cli('decode', PROGRAM, PAYLOADS[0], '--store', store);
  assert.equal(plain.code, 0, plain.stderr.slice(0, 300));
  const plainView = JSON.parse(plain.stdout);
  assert.equal(plainView.idl.source, 'metadata',
    'plain decode must still read the on-chain receipt after adoption');
  assert.equal(plainView.roundTripByteExact, false,
    'plain decode still reports the 8-byte tail as unexplained — the default is unchanged');
});
