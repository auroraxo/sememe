// The measurement pin for the DiabLokxis adoption-coverage re-measurement
// (12.11. PULS AA, the card's declared next step 3: "ecosystem-coverage
// Re-Messung (DiabLokxis 102 jetzt zaehlbar)"):
//   research/diablo-adoption-coverage-2026-11-12.json
//
// The artifact holds a TWO-HALVED answer, and every face below pins which
// half is which:
//
//   * the card's premise is FALSE at the shipped store: re-running the
//     committed fixture through the coverage tool on the WIRED tree
//     reproduces the committed ecosystem artifact exactly — 88.5%,
//     DiabLokxis 0/102, noInterface 102. The wiring changed the codec,
//     not the store; the diabloarb copy carries NO license at the pin
//     (license API 404 at f5005ac4 AND at main, repo field null — pinned
//     here from the live GitHub API when gh is authenticated, skipped by
//     name otherwise), so it cannot ship inside the store.
//   * the premise is TRUE on the adoption path: for a user who adopts the
//     pinned first-party copy through src/adopt.mjs, the SAME 102 payloads
//     move to decoded — 102/102, 0 refused, 102 byte-exact, headline
//     88.8% -> 89.3%, outside-watchlist 63.8% -> 65.9%, and the increase
//     rides the ADOPTED evidence column ONLY (pulled untouched).
//   * the committed store was not touched by the run (readdir+hash
//     digest before/after, recorded as committedStoreModified: false).
//
// Falsification half (this file): the artifact's numbers are the ones the
// tool derives RIGHT NOW from the committed fixture (same convention as
// test/ecosystem-coverage.test.mjs); every pinned invariant turns the test
// red when the artifact is tampered with; a wrong pin hash makes the tool
// exit 3; no arguments exits 2.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-diablo-adoption-coverage.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'diablo-adoption-coverage-2026-11-12.json');
const ECOSYSTEM = path.join(ROOT, 'research', 'ecosystem-coverage-2026-11-11.json');
const DIABLO = 'DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z';
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
const rowOf = (art, prog) => (art.programs ?? []).find((p) => p.program === prog);

test('the artifact carries no host path', () => {
  const text = readFileSync(ARTIFACT, 'utf8');
  assert.doesNotMatch(text, /\/home\//, 'a committed measurement must not name a home directory');
  assert.doesNotMatch(text, /\/tmp\//, 'a committed measurement must not name a scratch path');
});

test('the shipped-store premise is FALSE and pinned so: baseline reproduces the committed ecosystem artifact', () => {
  const eco = JSON.parse(readFileSync(ECOSYSTEM, 'utf8'));
  const { baseline } = artifact;
  for (const key of ['measuredPayloads', 'decoded', 'refused', 'noInterface', 'byteExact',
    'coveredPctOfMeasured', 'coveredPctOfAllSeen']) {
    assert.equal(baseline[key], eco.headline[key], `baseline.${key} must equal the committed ecosystem artifact`);
  }
  // The measured headline at the shipped store is UNCHANGED by the wiring:
  // 2026-11-13: the count-from-header fix moved it to 18,967/21,350 = 88.8%.
  assert.equal(baseline.decoded, 18_967);
  assert.equal(baseline.coveredPctOfMeasured, 88.8);
  assert.equal(baseline.diabRow.decoded, 0, 'the 102 remain no-interface at the shipped store');
  assert.equal(baseline.diabRow.noInterface, 102);
  assert.equal(artifact.premiseCheck.shippedStore.startsWith('FALSE'), true);
});

test('the adoption-path premise is TRUE and pinned so: 102/102 via ONE adopt through the product write path', () => {
  const { union } = artifact;
  assert.equal(union.diabRow.decoded, 102);
  assert.equal(union.diabRow.refused, 0);
  assert.equal(union.diabRow.noInterface, 0);
  assert.equal(union.diabRow.byteExact, 102, 'every adopted decode re-encodes byte-exactly at the coverage layer');
  assert.equal(union.diabRow.decodedAdopted, 102, 'all 102 ride the ADOPTED evidence class, never pulled');
  assert.equal(union.decoded, 19_069);
  assert.equal(union.coveredPctOfMeasured, 89.3);
  assert.equal(union.outsideWatchlist.coveredPct, 65.9);
});

test('the split is arithmetic, not narration: delta equals the pinned +/-102 on every column', () => {
  assert.deepEqual(artifact.delta, {
    decoded: 102,
    noInterface: -102,
    coveredPctOfMeasured: [88.8, 89.3],
    outsideWatchlistPct: [63.8, 65.9],
    byteExact: 102,
  });
  // pulled class may not move; adopted moves by exactly 102.
  assert.equal(artifact.baseline.decodedVia.pulled, artifact.union.decodedVia.pulled);
  assert.equal(artifact.union.decodedVia.adopted, artifact.baseline.decodedVia.adopted + 102);
  assert.equal(artifact.committedStoreModified, false);
});

test('the pin names the license situation it relies on (no license at the pin -> not vendored)', () => {
  assert.equal(artifact.pin.repo, 'cryptodiablo/diabloarb');
  assert.equal(artifact.pin.license, null, 'the artifact must state the license absence it gates on');
  assert.equal(artifact.pin.canonicalFingerprint,
    'd6d4e8aac4eb4199fb7b5ff818fcf04d4bd43793b9fc72d0652163b1d0711ec9');
  assert.equal(artifact.source.vendored, false);
  assert.equal(artifact.receipt.slot, null,
    'the adopted object is slot-null by construction — a pulled receipt would mean vendoring');
});

test('the license fact is live-checked against GitHub, not narrated', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    await run('gh', ['auth', 'status'], { timeout: 15_000 });
  } catch {
    t.skip('gh CLI not authenticated; skipping the live license check (named skip, same class as the other pin tests)');
    return;
  }
  for (const ref of [artifact.pin.commit, 'HEAD']) {
    const res = await run('gh', ['api',
      `repos/${artifact.pin.repo}/license?ref=${ref}`,
      '--include'], { timeout: 60_000, maxBuffer: 4 << 20 }).catch((error) => ({ stdout: String(error.stdout ?? '') }));
    assert.match(String(res.stdout), /404 Not Found/,
      `license endpoint at ${ref} must answer 404 (no license) while this artifact holds that absence`);
  }
});

test('the artifact is what the tool derives right now (no hand-edited numbers)', async (t) => {
  // Re-derivation needs the pinned source file, which is NOT vendored —
  // fetched at the pin over the network like the PULS X/Y/Z measurements,
  // skipped by NAME when gh is not authenticated (CI must not silently
  // pass a hand-edited artifact: the offline pins above still decide on
  // every field, only the byte-identical re-run is network-gated).
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    await run('gh', ['auth', 'status'], { timeout: 15_000 });
  } catch {
    t.skip('gh CLI not authenticated; skipping full re-derivation');
    return;
  }
  const { stdout } = await run('gh', ['api',
    `repos/${artifact.pin.repo}/contents/${artifact.pin.file}?ref=${artifact.pin.commit}`,
    '-H', 'Accept: application/vnd.github.raw'], { timeout: 60_000, maxBuffer: 8 << 20 });
  const fresh = path.join(ROOT, 'research', '.diablo-adoption-fresh.json');
  const source = path.join(ROOT, 'research', `.diablo-adoption-pin-${process.pid}.json`);
  try {
    writeFileSync(source, stdout);
    execFileSync(process.execPath, [TOOL, '--source', source, '--out', fresh], {
      cwd: ROOT, stdio: 'ignore', timeout: 600_000,
    });
    assert.ok(existsSync(fresh), 'the tool produced no output');
    const produced = JSON.parse(readFileSync(fresh, 'utf8'));
    const strip = (a) => {
      const copy = { ...a };
      delete copy.generatedAt;
      return copy;
    };
    assert.deepEqual(strip(produced), strip(artifact),
      'the committed artifact is not what the tool derives — re-run the tool and commit its output');
  } finally {
    rmSync(fresh, { force: true });
    rmSync(source, { force: true });
  }
});

test('tool falsification: no arguments exits 2 with usage', () => {
  const res = spawnSync(process.execPath, [TOOL], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage: measure-diablo-adoption-coverage\.mjs/);
});

test('tool falsification: a tampered source exits 3 with the pin hash mismatch', () => {
  const tampered = path.join(os.tmpdir(), `diablo-pin-tampered-${process.pid}.json`);
  const cached = path.join(os.tmpdir(), 'diablo-pin.json');
  const base = existsSync(cached)
    ? JSON.parse(readFileSync(cached, 'utf8'))
    : { name: 'diabloarb_executor_tampered', program_id: DIABLO, encoding: 'little-endian',
      types: { Hop: { size: 5, fields: [] } },
      instructions: [{ name: 'search', tag: 1, data: [{ name: 'tag', type: 'u8', value: 1 }] }] };
  base.instructions[0].name = `${base.instructions[0].name}_tampered`;
  writeFileSync(tampered, JSON.stringify(base));
  try {
    const res = spawnSync(process.execPath, [TOOL, '--source', tampered,
      '--out', path.join(os.tmpdir(), `diablo-tampered-out-${process.pid}.json`)],
      { encoding: 'utf8', timeout: 60_000 });
    assert.equal(res.status, 3, 'a file that does not hash to the pin must be NO VERDICT');
    assert.match(res.stderr, /diabloarb-pin-hash-mismatch/);
  } finally {
    rmSync(tampered, { force: true });
    rmSync(path.join(os.tmpdir(), `diablo-tampered-out-${process.pid}.json`), { force: true });
  }
});
