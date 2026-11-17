// test/store-damage-voice-published-measurement.test.mjs — the DELIVERY
// measurement of the store-damage voice, asked at the CHANNEL.
//
// This file pins the committed artifact of
// tools/measure-store-damage-voice-published.mjs:
//
//   research/store-damage-voice-published-2026-11-17.json
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE WORKING-TREE MEASUREMENT
// (test/store-damage-voice.test.mjs):
//   The working-tree measurement asks whether THIS code refuses. It cannot
//   say what a stranger receives. This repo's most-repeated defect class is
//   exactly that gap — "main fixed, the pin pointing behind it" — so two
//   PUBLISHED npm versions are installed into two empty apps and the SAME
//   byte-identical probe (tools/store-damage-voice-probe.mjs) runs inside
//   each installed package.
//
// WHAT THE MEASUREMENT FOUND:
//
//   sememe@0.4.32 (the version the README pinned until v0.4.33) carries the
//   defect on the published channel: 4 of the 11 damage faces leak the
//   kernel's errno, and ALL 11 refusals are unnamed and repairless.
//
//   sememe@0.4.33 refuses all 11 in the product's voice — every face carries
//   a code (store-receipt-* / store-object-*) and a repair, none quotes the
//   kernel, all stay on the work channel (exit 1), and the caller-path
//   control keeps the usage channel (exit 2).
//
// FALSIFICATION:
//   The artifact must show the OLDER published version carrying the defect
//   and the NEWER one refusing it; a version that could not be installed is
//   never called clean, and the tool fails when the baseline shows no
//   defect at all (an unmeasurable baseline makes the fix unprovable).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACT = path.join(ROOT, 'research', 'store-damage-voice-published-2026-11-17.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

const DAMAGE_FACES = [
  'receiptIsFile', 'receiptUnreadable', 'receiptNotJson', 'receiptForeign',
  'receiptMalformed', 'objectIsFile', 'objectUnreadable', 'objectNotJson',
  'objectNoInstructions', 'objectMissing', 'objectRehash',
];
const CONTROLS = ['decodeOk', 'noStoreAnswer', 'noStoredIdlAnswer', 'callerPathVoice'];

test('the artifact measures two installed versions and reaches a verdict', () => {
  assert.equal(artifact.carrier.installedVersion, artifact.carrier.version,
    'the carrier version must be the one actually installed from the registry');
  assert.equal(artifact.fixed.installedVersion, artifact.fixed.version,
    'the fixed version must be the one actually installed from the registry');
  assert.notEqual(artifact.carrier.version, artifact.fixed.version,
    'a comparison against itself measures nothing');
  assert.equal(artifact.verdict, 'store-damage-voice-held-on-the-published-channel');
});

test('the OLDER published version carries the defect — a clean baseline would not prove anything', () => {
  assert.ok(artifact.preFixLeakedErrnoFaces > 0,
    'the published carrier must leak the kernel somewhere, otherwise the fix is unprovable');
  assert.ok(artifact.preFixUnnamedFaces > 0,
    'the published carrier must answer without a code somewhere');
  assert.ok(artifact.preFixRepairlessFaces > 0,
    'the published carrier must answer without a repair somewhere');
});

test('the NEWER published version names every damage refusal and never quotes the kernel', () => {
  assert.equal(artifact.fixedLeakedErrnoFaces, 0,
    'no refusal on the fixed published version may quote the kernel');
  assert.equal(artifact.fixedUnnamedFaces, 0,
    'every damage refusal must carry a product code');
  assert.equal(artifact.fixedRepairlessFaces, 0,
    'every damage refusal must carry a repair');
  assert.equal(artifact.damageFaces, DAMAGE_FACES.length,
    'every damage face must be part of the measurement');
  for (const face of DAMAGE_FACES) {
    assert.ok(artifact.fixedCodes[face], `${face} must carry a code`);
    assert.ok(artifact.fixedRepairs[face], `${face} must carry a repair`);
  }
});

test('the CHANNEL does not move: damage stays on the work channel', () => {
  assert.equal(artifact.fixedWrongChannelFaces, 0,
    'a damage refusal must keep exit 1 — the store path was usable');
  for (const face of DAMAGE_FACES) {
    assert.equal(artifact.fixedExits[face], 1, `${face} must keep exit 1`);
  }
  assert.equal(artifact.controls.callerPathVoice.exit, 2,
    'the caller-named path control must keep the usage channel (exit 2)');
  assert.equal(artifact.controls.callerPathVoice.code, 'store-not_a_directory');
  assert.equal(artifact.controls.decodeOk.exit, 0,
    'an intact store must still decode');
});

test('the controls did not change verdict between the two published versions', () => {
  assert.equal(artifact.controlRegression, 0,
    `controls changed between the published versions: ${(artifact.controlRegressionNames || []).join(', ')}`);
  assert.deepEqual(Object.keys(artifact.controls).sort(), [...CONTROLS].sort());
});

test('the artifact quotes no host path', () => {
  assert.equal(artifact.hostPathLeak, false,
    'research/ is committed — an artifact that prints this host\'s paths must never be committed');
});
