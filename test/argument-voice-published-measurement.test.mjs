// test/argument-voice-published-measurement.test.mjs — the DELIVERY
// measurement of the forgotten-argument voice, asked at the CHANNEL.
//
// This file pins the committed artifact of
// tools/measure-argument-voice-published.mjs:
//
//   research/argument-voice-published-2026-11-18.json
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE WORKING-TREE MEASUREMENT
// (test/argument-voice.test.mjs):
//   The working-tree measurement asks whether THIS code answers. It cannot
//   say what a stranger receives. This repo's most-repeated defect class is
//   exactly that gap — "main fixed, the pin pointing behind it" — so two
//   PUBLISHED npm versions are installed into two empty apps and the SAME
//   byte-identical probe (tools/argument-voice-probe.mjs) runs inside each
//   installed package.
//
// WHAT THE MEASUREMENT FOUND:
//
//   sememe@0.4.37 (the version the README pinned until v0.4.38) answers
//   every forgotten or wrong argument as bare prose: 26 of 26 faces carry
//   NO code and NO repair, and all 26 travel on exit 1 — the caller's own
//   mistake sharing the channel with a drifted store or a tampered receipt.
//
//   sememe@0.4.38 answers all 26 with their own code, the command's
//   original sentence and a repair, on exit 2 (usage/IO), because nothing
//   ran. Answers and real work refusals keep exit 1; the five controls
//   keep their channels in both versions.
//
// FALSIFICATION:
//   The artifact must show the OLDER published version carrying the defect
//   and the NEWER one fixing it; a version that could not be installed is
//   never called clean, and the tool fails when the baseline shows no
//   defect at all (an unmeasurable baseline makes the fix unprovable).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACT = path.join(ROOT, 'research', 'argument-voice-published-2026-11-18.json');
const TOOL = path.join(ROOT, 'tools', 'measure-argument-voice-published.mjs');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

const FACES = [
  'pullMissingId', 'gapMissingId',
  'adoptMissingId', 'adoptMissingFile',
  'decodeMissingId', 'decodeMissingPayload',
  'decodeTrailingBadValue', 'decodeAbsentBadValue',
  'conformMissingFile',
  'decodeNativeTrailingBadValue', 'decodeTokenTrailingBadValue',
  'decodeRaydiumTrailingBadValue', 'decodeAtaTrailingBadValue',
  'decodeNativeMissingId', 'decodeNativeMissingPayload',
  'decodeTokenMissingId', 'decodeTokenMissingPayload',
  'decodeRaydiumMissingId', 'decodeRaydiumMissingPayload',
  'decodeAtaMissingId', 'decodeAtaMissingPayload', 'decodeAtaBothPayloads',
  'accountMissingId', 'accountMissingData', 'accountTrailingBadValue',
  'verifyModeBadValue',
];
const CONTROLS = [
  'absentHelpOk', 'nativeProvenanceOk', 'ataEmptyOk',
  'conformOnlyValid', 'conformOnlyMissingValue',
];
// The controls keep their channels in BOTH published versions:
//   an argument refusal (nothing ran)                -> 2
//   a real store answer / store refusal               -> 1
//   a working command                                 -> 0
const CONTROL_EXIT = {
  absentHelpOk: 0, nativeProvenanceOk: 0, ataEmptyOk: 0,
  conformOnlyValid: 1, conformOnlyMissingValue: 2,
};

test('the artifact measures two installed versions and reaches a verdict', () => {
  assert.equal(artifact.carrier.installed, artifact.carrier.requested,
    'the carrier version must be the one actually installed from the registry');
  assert.equal(artifact.fixed.installed, artifact.fixed.requested,
    'the fixed version must be the one actually installed from the registry');
  assert.notEqual(artifact.carrier.requested, artifact.fixed.requested,
    'a comparison against itself measures nothing');
  assert.equal(artifact.verdictName, 'argument-voice-held-on-the-published-channel');
});

test('the OLDER published version carries the defect — a clean baseline would not prove anything', () => {
  assert.ok(artifact.verdict.carrierUnnamedFaces > 0,
    'the published carrier must refuse without a code somewhere, otherwise the fix is unprovable');
  assert.equal(artifact.verdict.carrierUnnamedFaces, FACES.length,
    'all twenty-six faces refused unnamed on the carrier');
  assert.equal(artifact.verdict.carrierRepairlessFaces, FACES.length,
    'and all twenty-six without a repair');
  for (const face of FACES) {
    const row = artifact.detail[face].carrier;
    assert.equal(row.code, null, `${face} must refuse without a code on sememe@${artifact.carrier.version}`);
    assert.equal(row.fix, null, `and without a repair: ${face}`);
  }
});

test('the OLDER published version puts the caller\'s mistake on the WORK channel', () => {
  assert.equal(artifact.verdict.carrierWrongChannelFaces, FACES.length,
    'every argument refusal travelled on exit 1 — sharing the channel with a drifted store');
  for (const face of FACES) {
    assert.equal(artifact.detail[face].carrier.exit, 1,
      `${face} must answer on exit 1 on sememe@${artifact.carrier.version}`);
  }
});

test('the NEWER published version names every refusal and repairs it', () => {
  assert.equal(artifact.verdict.fixedUnnamedFaces, 0,
    'every refusal must carry a product code on the fixed published version');
  assert.equal(artifact.verdict.fixedRepairlessFaces, 0,
    'every refusal must carry a repair');
  for (const face of FACES) {
    const row = artifact.detail[face].fixed;
    assert.ok(row.code, `${face} must carry a code: ${JSON.stringify(row)}`);
    assert.ok(row.fix, `${face} must carry a repair: ${JSON.stringify(row)}`);
  }
});

test('the CHANNEL follows what ran — an invocation mistake is exit 2, and the controls keep theirs', () => {
  assert.equal(artifact.verdict.fixedWrongChannelFaces, 0,
    `a face left its channel: ${artifact.verdict.fixedWrongChannelFaces}`);
  for (const face of FACES) {
    assert.equal(artifact.detail[face].fixed.exit, 2,
      `${face} must answer on the usage channel (exit 2) — nothing ran`);
  }
  for (const control of CONTROLS) {
    assert.equal(artifact.controlsDetail[control].fixed.exit, CONTROL_EXIT[control],
      `${control} must keep exit ${CONTROL_EXIT[control]}`);
    assert.equal(artifact.controlsDetail[control].carrier.exit, CONTROL_EXIT[control],
      `${control} must have kept exit ${CONTROL_EXIT[control]} on the carrier too`);
  }
});

test('the controls did not change verdict between the two published versions', () => {
  assert.deepEqual(artifact.verdict.controlRegression, 0,
    `controls changed between the published versions: ${artifact.verdict.controlRegression}`);
  assert.deepEqual(Object.keys(artifact.controlsDetail).sort(), [...CONTROLS].sort());
});

test('the artifact quotes no host path', () => {
  assert.equal(artifact.hostPathLeak, 0,
    'research/ is committed — an artifact that prints this host\'s paths must never be committed');
  assert.equal(artifact.tempPathLeak, 0);
});

test('the committed artifact is the one the tool derives — re-run it and it must agree', async () => {
  // The artifact must be reproducible, not narrated: re-run the TOOL (two
  // npm installs + the probe in each installed package) and compare the
  // verdict and the counts. This is the leg that makes the mutation ladder
  // able to catch a probe, a tool or an artifact that drifts from what the
  // channel really says — without it, the mutations would mutate code
  // nothing reads.
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const fresh = path.join(os.tmpdir(), `argument-voice-published-fresh-${process.pid}.json`);
  try {
    const res = spawnSync(process.execPath, [TOOL, '--out', fresh], {
      cwd: ROOT, encoding: 'utf8', timeout: 1200000,
    });
    // exit 0 = the fresh run holds the claim; exit 1 = the claim is FALSE now.
    const produced = fs.existsSync(fresh) ? JSON.parse(fs.readFileSync(fresh, 'utf8')) : null;
    assert.ok(produced, `the tool must produce an artifact (exit ${res.status}): ${String(res.stderr ?? '').slice(-500)}`);
    assert.equal(res.status, 0,
      `the fresh published measurement must hold: ${produced.verdictName}`);
    assert.equal(produced.verdictName, artifact.verdictName,
      'the committed verdict must be the one the tool derives now');
    assert.deepEqual(produced.verdict, artifact.verdict,
      'the committed counts must be what the tool measures now (no hand-edited numbers)');
    assert.equal(produced.carrier.installed, artifact.carrier.installed, 'same carrier');
    assert.equal(produced.fixed.installed, artifact.fixed.installed, 'same fixed version');
  } finally {
    try { fs.rmSync(fresh, { force: true }); } catch { /* temp file, ignore */ }
  }
});
