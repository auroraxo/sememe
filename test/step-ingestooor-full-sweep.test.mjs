// step-ingestooor-full-sweep.test.mjs — the full foreign fixture set, one instrument.
//
// The first foreign run (test/foreign-repo-json-ingest.test.mjs) docked onto
// SEVEN hand-picked fixtures of step-finance-oss/step-ingestooor. The card's
// next step is the rest of the set: ALL 156 transaction fixtures the repo
// holds (119 standard getTransaction + 37 flattened dialect), measured with
// the SAME tool — not a parallel instrument. Acquisition gaps are quantified
// from the rows (which programs, how many payloads) instead of guessed.
//
// The clone convention: step-finance-oss/step-ingestooor is cloned to
// ~/github_repos/step-ingestooor (commit 001cf39, MIT). CI checks it out
// next to this repository; the same checkout path works locally. The fixtures
// are READ from the clone, never copied into this repository (only the seven
// verbatim fixtures of the first run live here, with their LICENSE notice).
//
// Falsification ladder:
//   - the sweep does not exist on the pre-tree   -> T1/T2 red (exit 2, usage),
//   - the per-file verdicts cannot be attributed -> T2 red (missing per-file rows),
//   - the single-file path is broken by the change -> T3 red (totals drift),
//   - a tampered store object alters decoded count -> T4 red on tamper,
//   - a non-RPC fixture ALONE still exits 2 with the named reason
//     -> T5 GREEN ON EVERY TREE (false-positive guard: the strict single-file
//     contract is unchanged; a sweep that passed bad files silently would be
//     the wrong fix).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'stranger-decode.mjs');
const TRAFFIC_STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04');
const MEASURED = JSON.parse(await readFile(
  path.join(ROOT, 'research', 'step-ingestooor-full-sweep-2026-11-04.json'), 'utf8'));

// The foreign clone: CI checks it out beside this repo; locally the clone
// convention puts it in ~/github_repos/step-ingestooor.
const FOREIGN_REPO = process.env.SEMEME_STEP_INGESTOOR_PATH
  ?? (process.env.GITHUB_WORKSPACE
    ? path.join(process.env.GITHUB_WORKSPACE, 'step-ingestooor')
    : path.join(os.homedir(), 'github_repos', 'step-ingestooor'));
const FIXTURES_DIR = path.join(FOREIGN_REPO, 'crates', 'parsers', 'tests');
const hasForeignRepo = existsSync(FIXTURES_DIR);

/** Run the tool with the given args; returns { code, stdout, stderr }. */
function runTool(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [TOOL, ...args], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code ?? 1) : 0,
        stdout,
        stderr,
      });
    });
  });
}

test('the full 156-fixture foreign set sweeps diff-free through the ONE instrument', { skip: !hasForeignRepo && 'step-ingestooor clone not found (set SEMEME_STEP_INGESTOOR_PATH)' }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-sweep-'));
  try {
    const reportPath = path.join(tmp, 'sweep.json');
    const { code, stdout, stderr } = await runTool([
      '--store', TRAFFIC_STORE,
      '--fixtures-dir', FIXTURES_DIR,
      '--out', reportPath,
    ]);
    assert.equal(code, 0, `sweep must exit 0 (diff-free): ${stderr.slice(0, 400)}`);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.status, 'pass');
    assert.equal(report.networkAttempts, 0, 'the zero-RPC guard must hold across the whole sweep');

    const s = report.summary;
    // Measured 2026-11-04 on the clone @001cf39; pinned so a changed foreign
    // set or a broken sweep goes red instead of drifting silently.
    assert.equal(report.fixturesTotal, MEASURED.fixturesTotal, 'the repo holds 156 fixture files — a changed set must be re-measured, not smoothed over');
    assert.equal(report.fixturesUnreadable, 0, 'no foreign fixture may be dropped');
    assert.equal(s.transactionsChecked, MEASURED.transactionsChecked);
    assert.equal(s.transactionsUnreadable, 0);
    assert.equal(s.disagreements, 0, 'diff-free means zero disagreements');
    assert.equal(s.byteExactRate, 100, 'every decoded payload must re-encode byte-exactly');
    assert.equal(s.decoded, MEASURED.decoded, 'decoded payload count must match');
    assert.equal(s.decodeErrors, MEASURED.decodeErrors, 'decode error count must match');
    assert.equal(s.noInterface, MEASURED.noInterface, 'acquisition gap count must match');
    assert.equal(s.missingBytes, MEASURED.missingBytes, 'chain-parsed instructions must match');

    // The gap is quantified BY PROGRAM from the rows, not guessed. Pinned to
    // top 8 measured programs.
    const measuredTop = Object.entries(MEASURED.noInterfaceByProgram)
      .sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [program, count] of measuredTop) {
      assert.equal(s.noInterfacePrograms[program], count, `acquisition gap for ${program} changed — re-measure, do not edit the number`);
    }

    // Cross-consistency: the committed research artifact totals must equal a
    // fresh run of the same clone. A hand-edited artifact fails HERE.
    assert.equal(MEASURED.summary.decoded, s.decoded, 'research artifact totals must equal the live sweep');
    assert.equal(MEASURED.summary.noInterface, s.noInterface, 'research artifact totals must equal the live sweep');
    assert.equal(MEASURED.summary.missingBytes, s.missingBytes, 'research artifact totals must equal the live sweep');
    assert.equal(MEASURED.source.commit, '001cf39', 'the foreign pin must stay on the measured commit');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('every fixture of the sweep is individually verdict-carrying', { skip: !hasForeignRepo && 'step-ingestooor clone not found (set SEMEME_STEP_INGESTOOR_PATH)' }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-sweep-'));
  try {
    const reportPath = path.join(tmp, 'sweep.json');
    const { code } = await runTool([
      '--store', TRAFFIC_STORE,
      '--fixtures-dir', FIXTURES_DIR,
      '--out', reportPath,
    ]);
    assert.equal(code, 0);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.ok(Array.isArray(report.perFile) && report.perFile.length === report.fixturesTotal, 'the sweep must carry one verdict row per fixture, not only totals');
    for (const row of report.perFile) {
      assert.equal(row.unreadable, 0, `${row.file}: no transaction may be dropped`);
      assert.equal(row.disagreements, 0, `${row.file}: disagreements must be zero`);
      assert.ok(row.decoded > 0 || row.missingBytes > 0 || row.noInterface > 0, `${row.file}: a fixture must decode something, prove it carries no bytes, or name its missing interface`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('the single-file path is unchanged by the sweep (totals identical)', { skip: !hasForeignRepo && 'step-ingestooor clone not found (set SEMEME_STEP_INGESTOOR_PATH)' }, async () => {
  // First fixture of the measured sweep, run ALONE through --rpc-response:
  // the copy-paste path every stranger uses must give byte-identical
  // counters to the sweep's per-file row.
  const first = MEASURED.perFile[0].file;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-single-'));
  try {
    const reportPath = path.join(tmp, 'single.json');
    const { code, stdout } = await runTool([
      '--store', TRAFFIC_STORE,
      '--rpc-response', path.join(FIXTURES_DIR, first),
      '--out', reportPath,
    ]);
    assert.equal(code, 0, `single-file run on ${first} must still pass`);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const row = MEASURED.perFile.find((entry) => entry.file === first);
    assert.equal(report.summary.decoded, row.decoded, 'single-file decoded must equal the sweep row');
    assert.equal(report.summary.noInterface, row.noInterface, 'single-file noInterface must equal the sweep row');
    assert.equal(report.summary.missingBytes, row.missingBytes, 'single-file missingBytes must equal the sweep row');
    const live = JSON.parse(stdout);
    assert.equal(live.status, 'pass');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a tampered store object breaks the sweep assertion (falsification)', { skip: !hasForeignRepo && 'step-ingestooor clone not found (set SEMEME_STEP_INGESTOOR_PATH)' }, async () => {
  // Tampering with an object in the store must alter the decoded count: the
  // sweep assertions are tight, so any regression in the store's integrity
  // will fail the test instead of passing silently.
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-mut-'));
  try {
    const mutStore = path.join(tmp, 'store');
    await cp(TRAFFIC_STORE, mutStore, { recursive: true });
    // Find the Whirlpool object and corrupt it
    const objectsDir = path.join(mutStore, 'objects');
    const objects = await readdir(objectsDir);
    assert.ok(objects.length > 0, 'mutStore must have objects');
    const targetFile = path.join(objectsDir, objects[0]);
    const obj = JSON.parse(await readFile(targetFile, 'utf8'));
    // Walk to the first numeric field (the same mutation measured by hand:
    // the decode output changes — 493 -> 438 decoded, 7 -> 62 refusals).
    const walk = (node) => {
      if (Array.isArray(node)) {
        for (const child of node) { const hit = walk(child); if (hit) return hit; }
      } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (typeof value === 'number' && key !== 'discriminator') return { key, value, node };
          const hit = walk(value); if (hit) return hit;
        }
      }
      return null;
    };
    const hit = walk(obj);
    assert.ok(hit, 'the store object must contain a numeric field to mutate');
    hit.node[hit.key] = hit.value + 1;
    await writeFile(targetFile, JSON.stringify(obj));

    const reportPath = path.join(tmp, 'sweep-tampered.json');
    await runTool([
      '--store', mutStore,
      '--fixtures-dir', FIXTURES_DIR,
      '--out', reportPath,
    ]);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    // The tampered object fails fingerprint verification -> fewer decoded payloads
    assert.notEqual(report.summary.decoded, MEASURED.decoded,
      'tampered store must yield a different decoded count');
    assert.ok(report.summary.decodeErrors > MEASURED.decodeErrors,
      'tampered store must increase decode errors');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('G5 false-positive guard: a non-RPC fixture ALONE still exits 2 with the named reason', async () => {
  // The strict single-file contract must stay untouched: a file that is not
  // an RPC response refuses with `not-an-rpc-response` (exit 2, usage/IO), on
  // every tree. Tested with a synthetic non-RPC fixture (a flat object with
  // neither a transaction nor instructions array).
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-bad-'));
  try {
    const badFile = path.join(tmp, 'not-a-tx.json');
    await writeFile(badFile, JSON.stringify({ name: 'just-an-object', value: 42 }));
    const { code, stderr } = await runTool([
      '--store', TRAFFIC_STORE,
      '--rpc-response', badFile,
    ]);
    assert.equal(code, 2, `a non-RPC fixture alone must exit 2 (usage/IO), got ${code}`);
    assert.match(stderr, /not-an-rpc-response/, 'the refusal must name the reason');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
