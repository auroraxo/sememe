// adopt-foreign-first-party.test.mjs — the measured first-party share of the
// publish-nothing gap is ADOPTED, not asserted.
//
// What the classification measured (research/publish-nothing-classification-2026-11-04.json):
// 7 of the 35 publish-nothing programs have a first-party IDL inside the
// foreign repository itself (crates/idl-gens/idls/, MIT, commit 001cf39).
// The card's own pattern (Lighthouse, commit 0812300) already proved the
// acquisition class; this test proves it for all 7 and measures what the
// sweep does with them.
//
// Ladder (run against pre-tree: T1..T5 red, G1 green on both):
//   T1: tool exists and enforces the CLI contract (exit 2 without args)
//   T2: the plan comes from the SWEEP report and verifies each file against
//       its own declared address; a file declaring another program is NOT adoptable
//   T3: the plan is exactly the 7 measured programs / 22 payloads
//   T4: adoption writes receipt + object through `sememe adopt`; the object
//       re-hashes to the receipt fingerprint (offline-verifiable)
//   T5: the committed artifact agrees with the store and with the committed
//       classification artifact
//   G1: false-positive guard: the shank sweep artifact keeps its headline (87)

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/canonical.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'adopt-foreign-first-party.mjs');
const SHANK_REPORT = path.join(ROOT, 'research', 'step-ingestooor-full-sweep-shank-2026-11-04.json');
const CLASSIFICATION = path.join(ROOT, 'research', 'publish-nothing-classification-2026-11-04.json');
const ARTIFACT = path.join(ROOT, 'research', 'adopt-foreign-first-party-2026-11-04.json');
const PULLED_STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled');

const FOREIGN_REPO = process.env.SEMEME_STEP_INGESTOOR_PATH
  ?? (process.env.GITHUB_WORKSPACE
    ? path.join(process.env.GITHUB_WORKSPACE, 'step-ingestooor')
    : path.join(os.homedir(), 'github_repos', 'step-ingestooor'));
const hasForeignRepo = existsSync(path.join(FOREIGN_REPO, 'crates', 'idl-gens', 'idls'));

function runTool(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [TOOL, ...args], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}

test('T1: tool exists and enforces the CLI contract', async () => {
  const { code, stderr } = await runTool([]);
  assert.equal(code, 2, 'usage refusal expected');
  assert.match(stderr, /--sweep/);
  assert.match(stderr, /--store/);
});

test('T2: a file declaring another program is not adoptable', async () => {
  const { verifyForeignIdl } = await import(TOOL);
  const titan = path.join(FOREIGN_REPO, 'crates', 'idl-gens', 'idls', 'titan.json');
  if (!existsSync(titan)) return; // foreign repo absent: nothing to falsify
  const ok = verifyForeignIdl('T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT', titan);
  assert.equal(ok.adoptable, true);
  assert.equal(ok.addressMatches, true);
  const wrong = verifyForeignIdl('SomeOtherProgram1111111111111111111111111111', titan);
  assert.equal(wrong.adoptable, false, 'a mismatching address must never be adopted under another program');
  assert.equal(wrong.addressMatches, false);
});

test('T3: the plan is exactly the measured 7 programs / 22 payloads', { skip: !hasForeignRepo && 'foreign repo required' }, async () => {
  const { plan } = await import(TOOL);
  const shank = JSON.parse(await readFile(SHANK_REPORT, 'utf8'));
  const rows = plan(shank, { foreignRepo: FOREIGN_REPO });
  assert.equal(rows.length, 7, 'measured: 7 publish-nothing programs have a first-party IDL');
  assert.equal(rows.reduce((n, r) => n + r.payloads, 0), 22, 'measured: 22 payloads behind them');
  const programs = rows.map((r) => r.program);
  for (const p of [
    'FL3X2pRsQ9zHENpZSKDRREtccwJuei8yg9fwDu9UN69Q',
    'NXFiKimQN3QSL3CDhCXddyVmLfrai8HK36bHKaAzK7g',
    'endoLNCKTqDn8gSVnN2hDdpgACUPWHZTwoYnnMybpAT',
    'sSo1iU21jBrU9VaJ8PJib1MtorefUV4fzC9GURa2KNn',
    'RopsJ74nrtcsk9iND8CFFNjn5mxf1tFzF3RhMPJ3CdV',
    'T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT',
    'Stk5NCWomVN3itaFjLu382u9ibb5jMSHEsh6CuhaGjB',
  ]) {
    assert.ok(programs.includes(p), `${p} must be in the plan`);
  }
  // The plan must agree with the committed CLASSIFICATION artifact — the same
  // 7 programs, not a second opinion.
  const classification = JSON.parse(await readFile(CLASSIFICATION, 'utf8'));
  const classified = classification.rows
    .filter((r) => r.verdict === 'first-party-foreign-idl')
    .map((r) => r.program)
    .sort();
  assert.deepEqual([...programs].sort(), classified, 'plan and classification must name the same programs');
});

test('T4: adoption writes a receipt + object that re-hash', { skip: !hasForeignRepo && 'foreign repo required' }, async () => {
  const { plan, sweepAdopt } = await import(TOOL);
  const shank = JSON.parse(await readFile(SHANK_REPORT, 'utf8'));
  const rows = plan(shank, { foreignRepo: FOREIGN_REPO });
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-adopt-'));
  try {
    const { rows: adopted, summary } = await sweepAdopt(rows, { store });
    assert.equal(summary.adopted, 7);
    assert.equal(summary.adoptedPayloads, 22);
    assert.equal(summary.verdict, 'measured');
    const names = await readdir(path.join(store, 'receipts'));
    assert.equal(names.length, 7, 'one receipt per adopted program, no side writes');
    for (const row of adopted) {
      const receiptName = names.find((n) => n.startsWith(`${row.program}-`));
      assert.ok(receiptName, `${row.program} must have a receipt`);
      const receipt = JSON.parse(await readFile(path.join(store, 'receipts', receiptName), 'utf8'));
      assert.equal(receipt.source, 'first-party');
      assert.equal(receipt.program, row.program);
      assert.match(receipt.origin, /step-ingestooor-001cf39/, 'the origin must name repo, commit and file');
      const object = JSON.parse(await readFile(
        path.join(store, 'objects', `${receipt.fingerprint.replace('sha256:', '')}.json`), 'utf8'));
      const digest = createHash('sha256').update(`${canonicalJson(object)}\n`).digest('hex');
      assert.equal(`sha256:${digest}`, receipt.fingerprint, 'the object must re-hash to its receipt');
      assert.equal(object.address, row.program, 'the stored object declares the program');
    }
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test('T5: the committed artifact agrees with the store and the classification', async () => {
  assert.ok(existsSync(ARTIFACT), 'adoption artifact must be committed');
  const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));
  assert.equal(artifact.tool, 'adopt-foreign-first-party');
  assert.equal(artifact.summary.adopted, 7);
  assert.equal(artifact.summary.adoptedPayloads, 22);
  assert.equal(artifact.summary.verdict, 'measured');
  assert.equal(artifact.source.foreignCommit, '001cf39');
  // every artifact row must be present in the committed store, re-hashing
  for (const row of artifact.rows) {
    const receiptName = (await readdir(path.join(PULLED_STORE, 'receipts')))
      .find((n) => n.startsWith(`${row.program}-`) && n.includes('first-party'));
    assert.ok(receiptName, `${row.program} must have a first-party receipt in the committed store`);
    const receipt = JSON.parse(await readFile(path.join(PULLED_STORE, 'receipts', receiptName), 'utf8'));
    assert.equal(receipt.fingerprint, row.fingerprint);
    const object = JSON.parse(await readFile(
      path.join(PULLED_STORE, 'objects', `${row.fingerprint.replace('sha256:', '')}.json`), 'utf8'));
    const digest = createHash('sha256').update(`${canonicalJson(object)}\n`).digest('hex');
    assert.equal(`sha256:${digest}`, receipt.fingerprint);
  }
});

test('G1 false-positive guard: the shank sweep artifact keeps its headline (87 gap)', async () => {
  const shank = JSON.parse(await readFile(SHANK_REPORT, 'utf8'));
  assert.equal(shank.summary.noInterface, 87);
  assert.equal(shank.summary.decoded, 703);
  assert.equal(shank.summary.byteExactFull, 696);
  assert.equal(shank.summary.decodeErrors, 16);
});
