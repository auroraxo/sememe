// external-adoption-preview.test.mjs — does a DECLARED external interface
// actually decode the fixture bytes? Preview on a throwaway store, bytes never
// committed.
//
// WHY THIS FILE EXISTS
//
// The external-source sweep (research/unrepresented-external-sweep-2026-11-04.json)
// measured 4 of the 16 unrepresented programs (9 payloads) with an EXTERNAL
// interface whose file DECLARES the program (`metadata.address` match). That
// verdict is about bytes in foreign repositories — it says nothing about
// whether the bytes explain THIS repo's fixture payloads. The card's standing
// rule is byte arbitration, so the verdict is previewed end to end: adopt into
// a COPY of the store, run the identical sweep, and require that EXACTLY the
// adopted rows move.
//
// WHY THE BYTES ARE NOT COMMITTED (measured 2026-11-04)
//   - bitquery/solana-idl-lib (solfi.json, humidifi.json, zerofi.json):
//     license = null, no LICENSE file -> default copyright, all rights
//     reserved. Copying it into an MIT repository is not permitted.
//   - Bonasa-Tech/manifest (client/idl/wrapper.json): GPL-3.0 — copyleft that
//     must not silently enter an MIT store or the published npm package.
// So the preview runs on a THROWAWAY copy (tools/preview-external-adoption.mjs
// --work-dir), the committed artifact records sha256 + origin + license, and
// `committedStoreModified` stays false.
//
// FALSIFICATION (the part that can fail):
//   - adopting the 4 declared files must move EXACTLY the 4 adopted programs
//     in byProgram; any other row moving -> no-verdict (exit 3): the adoption
//     would have leaked into unrelated decode paths.
//   - a file whose content does not re-declare the program at adoption time
//     (stale index) is refused before any write.
//   - licenses are measured from the repo API, never assumed.
//
// Ladder (written FIRST; red on the pre-tree where the module does not exist,
// G1/G2 read only committed artifacts and stay green on both trees):
//   T1: tool exists and enforces the CLI contract (exit 2 without args)
//   T2: plan extraction: exactly the published rows, binding must be declared;
//       a hand-edited verdict or binding is refused
//   T3: comparison logic — moved rows outside the adopted set withhold the
//       verdict; only-adopted movement is measured
//   T4: license gate is recorded per source repo, not assumed
//   T5 (G): the committed preview artifact is pinned against the committed
//       baseline: 724->732 decoded, gap 65->56, exactly 4 moved rows,
//       0 disagreements, byte-exact 100%, committed store untouched
//   T6 (G): the external sweep artifact still pins 4 published / 9 payloads

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'preview-external-adoption.mjs');
const SWEEP = path.join(ROOT, 'research', 'unrepresented-external-sweep-2026-11-04.json');
const BASELINE = path.join(ROOT, 'research', 'step-ingestooor-full-sweep-classified-2026-11-04.json');
const PREVIEW = path.join(ROOT, 'research', 'external-adoption-preview-2026-11-04.json');
const COMMITTED_STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled');

const ADOPTED = [
  'SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe', // 4 payloads -> 4 decoded
  '9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp', // 1 payload -> 1 NAMED refusal (unknown discriminator)
  'wMNFSTkir3HgyZTsB7uqu3i7FA73grFCptPXgrZjksL', // 3 payloads -> 3 decoded
  'ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY', // 1 payload -> 1 decoded
];

function runTool(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [TOOL, ...args], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}

test('T1: tool exists and enforces the CLI contract', async () => {
  const { code, stderr } = await runTool([]);
  assert.equal(code, 2, 'usage refusal expected');
  assert.match(stderr, /--sweep/, 'must mention --sweep');
  assert.match(stderr, /--store/, 'must mention --store');
});

test('T2: plan extraction — published rows only, binding must be declared', async () => {
  const { planFromSweep } = await import(TOOL);
  const sweep = JSON.parse(await readFile(SWEEP, 'utf8'));
  const plan = planFromSweep(sweep);
  assert.equal(plan.length, 4, '4 published programs');
  assert.equal(plan.reduce((n, r) => n + r.payloads, 0), 9, '9 payloads');
  assert.deepEqual([...plan.map((r) => r.program)].sort(), [...ADOPTED].sort());
  for (const row of plan) {
    assert.equal(row.evidence?.binding, 'declared', 'only a declared binding is adoptable');
    assert.ok(row.evidence.repo && row.evidence.path, 'origin recorded');
  }

  // hand-edit: a reference-only row relabelled as published is refused
  const tampered = JSON.parse(JSON.stringify(sweep));
  const refRow = tampered.rows.find((r) => r.verdict === 'external-reference-only');
  refRow.verdict = 'external-interface-published';
  refRow.evidence = { repo: 'x/y', path: 'z.json', binding: 'declared' };
  assert.throws(() => planFromSweep(tampered), /4|9/,
    'a relabelled row must break the pinned 4/9 denominator');

  // hand-edit: an unbound evidence binding is refused per row
  const unbound = JSON.parse(JSON.stringify(sweep));
  unbound.rows.find((r) => r.verdict === 'external-interface-published').evidence.binding = 'literal-mention';
  assert.throws(() => planFromSweep(unbound), /declared/);
});

test('T3: comparison — only-adopted movement is measured, anything else withholds', async () => {
  const { compareRuns } = await import(TOOL);
  const adopted = ADOPTED;
  const A = ADOPTED[0]; // SolFi: 4 payloads, currently 0 decoded
  const B = 'SomeOtherProgram11111111111111111111111111111';
  const baseline = {
    decoded: 724, noInterface: 65,
    byProgram: {
      [A]: { payloads: 4, decoded: 0, decodeErrors: 0, disagreements: 0, noInterface: 4 },
      [B]: { payloads: 2, decoded: 2, decodeErrors: 0, disagreements: 0, noInterface: 0 },
    },
  };
  const previewOk = {
    decoded: 728, noInterface: 61,
    byProgram: {
      [A]: { payloads: 4, decoded: 4, decodeErrors: 0, disagreements: 0, noInterface: 0 },
      [B]: { payloads: 2, decoded: 2, decodeErrors: 0, disagreements: 0, noInterface: 0 },
    },
  };
  const ok = compareRuns(baseline, previewOk, adopted);
  assert.equal(ok.verdict, 'measured');
  assert.deepEqual(ok.moved, [A]);
  assert.equal(ok.decodedDelta, 4);

  // an UNADOPTED row moved -> the adoption leaked; verdict withheld
  const leak = JSON.parse(JSON.stringify(previewOk));
  leak.byProgram[B].decoded = 1;
  leak.byProgram[B].disagreements = 1;
  const bad = compareRuns(baseline, leak, adopted);
  assert.equal(bad.verdict, 'no-verdict');
  assert.ok(bad.leaked.length > 0, 'the leaked row is named');
  assert.equal(bad.leaked[0], B);

  // no movement at all: measured but empty (the preview is allowed to show
  // that nothing decoded — that is the falsifying outcome, not an error)
  const none = compareRuns(baseline, baseline, adopted);
  assert.equal(none.verdict, 'measured');
  assert.deepEqual(none.moved, []);
});

test('T4: license gate is recorded from the repo API, never assumed', async () => {
  const { licenseGate } = await import(TOOL);
  const gated = licenseGate([
    { repo: 'bitquery/solana-idl-lib', spdxId: null },
    { repo: 'Bonasa-Tech/manifest', spdxId: 'GPL-3.0' },
    { repo: 'Some/MIT-Repo', spdxId: 'MIT' },
  ]);
  assert.equal(gated.commitAllowed, false, 'unlicensed + copyleft sources block committing bytes');
  const byRepo = Object.fromEntries(gated.repos.map((r) => [r.repo, r]));
  assert.equal(byRepo['bitquery/solana-idl-lib'].state, 'unlicensed');
  assert.equal(byRepo['Bonasa-Tech/manifest'].state, 'copyleft');
  assert.equal(byRepo['Some/MIT-Repo'].state, 'permissive');
  assert.equal(licenseGate([{ repo: 'a/b', spdxId: 'MIT' }, { repo: 'c/d', spdxId: 'Apache-2.0' }]).commitAllowed, true);
});

test('T5 (G): the committed preview artifact is pinned against the committed baseline', { skip: !existsSync(PREVIEW) && 'preview not yet measured (run the tool first)' }, async () => {
  const preview = JSON.parse(await readFile(PREVIEW, 'utf8'));
  const baseline = JSON.parse(await readFile(BASELINE, 'utf8'));

  assert.equal(preview.summary.verdict, 'measured');
  assert.equal(preview.committedStoreModified, false, 'preview bytes must never land in the committed store');
  assert.equal(preview.licenseGate.commitAllowed, false,
    'the measured sources are unlicensed/copyleft — committing is gated');

  assert.equal(baseline.summary.decoded, 724);
  assert.equal(preview.summary.decoded, 732, 'decoded: 724 -> 732 (+8)');
  assert.equal(baseline.summary.noInterface, 65);
  assert.equal(preview.summary.noInterface, 56, 'gap: 65 -> 56');
  assert.equal(preview.summary.disagreements, 0, 'still diff-free');
  assert.equal(preview.summary.byteExactRate, 100, 'byte-exact stays 100%');
  assert.equal(preview.summary.decodeErrors, 18, '+1 NAMED refusal (humidifi unknown discriminator f6dc6...)');

  assert.equal(preview.summary.movedRows.length, 4, 'exactly the 4 adopted programs moved');
  assert.deepEqual([...preview.summary.movedRows].sort(), [...ADOPTED].sort());
  assert.equal(preview.summary.movedRowsUnadopted.length, 0, 'no unadopted row moved');

  assert.equal(preview.rows.length, 4);
  for (const row of preview.rows) {
    assert.match(row.sha256, /^[0-9a-f]{64}$/, 'content fingerprint recorded');
    assert.ok(row.license, 'license recorded per source');
    assert.ok(row.origin && row.origin.includes('@'), 'origin names repo@path');
  }

  // per-program movement matches the live measurement exactly
  const byProgram = preview.rows.map((r) => `${r.program}:${r.decodedBefore}->${r.decodedAfter}`);
  assert.ok(byProgram.includes(`${ADOPTED[0]}:0->4`), 'SoLFi 0->4');
  assert.ok(byProgram.includes(`${ADOPTED[3]}:0->1`), 'zerofi 0->1');
  assert.ok(byProgram.includes(`${ADOPTED[2]}:0->3`), 'manifest wrapper 0->3');
  assert.ok(byProgram.includes(`${ADOPTED[1]}:0->0`), 'humidifi stays 0 with a named refusal');
});

test('T6 (G): the external sweep artifact still pins 4 published / 9 payloads', async () => {
  const sweep = JSON.parse(await readFile(SWEEP, 'utf8'));
  assert.equal(sweep.summary.verdict, 'measured');
  assert.equal(sweep.summary.byVerdict['external-interface-published'], 4);
  assert.equal(sweep.summary.payloadsByVerdict['external-interface-published'], 9);
  assert.equal(sweep.summary.unknown, 0);
  assert.equal(sweep.control.matches, 1);
  assert.ok(sweep.rows.every((r) => r.premise.state === 'trace-only'),
    'every program is trace-only in the foreign repo (premise verified, not assumed)');
});
