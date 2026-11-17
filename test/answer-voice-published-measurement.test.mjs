// test/answer-voice-published-measurement.test.mjs — the DELIVERY
// measurement of the answer voice, asked at the CHANNEL.
//
// This file pins the committed artifact of
// tools/measure-answer-voice-published.mjs:
//
//   research/answer-voice-published-2026-11-17.json
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE WORKING-TREE MEASUREMENT
// (test/answer-voice.test.mjs):
//   The working-tree measurement asks whether THIS code answers. It cannot
//   say what a stranger receives. This repo's most-repeated defect class is
//   exactly that gap — "main fixed, the pin pointing behind it" — so two
//   PUBLISHED npm versions are installed into two empty apps and the SAME
//   byte-identical probe (tools/answer-voice-probe.mjs) runs inside each
//   installed package.
//
// WHAT THE MEASUREMENT FOUND:
//
//   sememe@0.4.35 (the version the README pinned until v0.4.36) answers
//   every store answer as bare prose: 6 of 6 faces carry NO code, because
//   the CLI prints `code` only together with `fix` and an answer has no
//   fix. The `lock` / `verify` call sites did not even mint a code.
//
//   sememe@0.4.36 answers all 6 with their own code, the `answer: true`
//   mark (acquire, do not repair) and NO repair — the sentences unchanged,
//   the channel unchanged (exit 1).
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
const ARTIFACT = path.join(ROOT, 'research', 'answer-voice-published-2026-11-17.json');
const TOOL = path.join(ROOT, 'tools', 'measure-answer-voice-published.mjs');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

const ANSWER_FACES = [
  'decodeNoStore', 'accountNoStore', 'lockNoStore', 'verifyNoStore',
  'decodeNoStoredIdl', 'accountNoStoredIdl',
];
const CONTROLS = ['greenGate', 'refusalVoice', 'damageVoice'];

test('the artifact measures two installed versions and reaches a verdict', () => {
  assert.equal(artifact.carrier.installed, artifact.carrier.requested,
    'the carrier version must be the one actually installed from the registry');
  assert.equal(artifact.fixed.installed, artifact.fixed.requested,
    'the fixed version must be the one actually installed from the registry');
  assert.notEqual(artifact.carrier.requested, artifact.fixed.requested,
    'a comparison against itself measures nothing');
  assert.equal(artifact.verdictName, 'answer-voice-held-on-the-published-channel');
});

test('the OLDER published version carries the defect — a clean baseline would not prove anything', () => {
  assert.ok(artifact.carrierUnnamedFaces.length > 0,
    'the published carrier must answer without a code somewhere, otherwise the fix is unprovable');
  assert.equal(artifact.carrierUnnamedFaces.length, ANSWER_FACES.length,
    'all six answer faces answered unnamed on the carrier');
  for (const face of ANSWER_FACES) {
    assert.equal(artifact.detail[face].carrier.code, null,
      `${face} must answer without a code on sememe@${artifact.carrier.version}`);
    assert.equal(artifact.detail[face].carrier.fix, null,
      `and without a repair: ${face}`);
  }
});

test('the NEWER published version names every answer and marks it as an answer', () => {
  assert.equal(artifact.fixedUnnamedFaces.length, 0,
    'every answer must carry a product code on the fixed published version');
  assert.equal(artifact.fixedUnmarkedFaces.length, 0,
    'every answer must carry `answer: true` — acquire, do not repair');
  assert.equal(artifact.fixedRepairedFaces.length, 0,
    'no answer may carry a repair — an answer is not a refusal');
  assert.equal(artifact.answerFaces.length, ANSWER_FACES.length,
    'every answer face must be part of the measurement');
  for (const face of ANSWER_FACES) {
    const row = artifact.detail[face].fixed;
    assert.ok(row.code, `${face} must carry a code: ${JSON.stringify(row)}`);
    assert.equal(row.answer, true, `${face} must be marked as an answer`);
    assert.equal(row.fix, null, `${face} must carry no repair`);
  }
});

test('the CHANNEL does not move and the sentences stay verbatim', () => {
  assert.equal(artifact.fixedWrongChannelFaces.length, 0,
    'an answer must keep exit 1 — nothing broke');
  assert.equal(artifact.fixedWrongSentenceFaces.length, 0,
    'an answer must keep its own sentence — it is quoted by the README and tests');
  for (const face of ANSWER_FACES) {
    assert.equal(artifact.detail[face].fixed.exit, 1, `${face} must keep exit 1`);
  }
  const missing = artifact.detail.decodeNoStore.fixed;
  assert.match(missing.error, /^no sememe store at .*: run "sememe pull" first$/,
    `the missing-store sentence must survive byte-for-byte: ${missing.error}`);
  const absent = artifact.detail.decodeNoStoredIdl.fixed;
  assert.match(absent.error, /^no stored IDL for program .+ in .+$/,
    `the no-stored-idl sentence must survive byte-for-byte: ${absent.error}`);
});

test('the refusal classes kept their own voice on the published channel', () => {
  const refusal = artifact.controlsDetail.refusalVoice.fixed;
  assert.equal(refusal.exit, 2, 'the caller-named path class must keep the usage channel');
  assert.equal(refusal.code, 'store-not_a_directory', 'and its own name');
  assert.ok(refusal.fix, 'and its repair');
  assert.equal(refusal.answer, false, '`answer: true` never rides on a refusal');
  const damage = artifact.controlsDetail.damageVoice.fixed;
  assert.equal(damage.exit, 1, 'damage must keep the work channel');
  assert.equal(damage.answer, false, '`answer: true` never rides on a refusal');
  assert.equal(artifact.controlsDetail.greenGate.fixed.green, true,
    'an intact store must still verify green');
});

test('the controls did not change verdict between the two published versions', () => {
  assert.deepEqual(artifact.controlRegression, [],
    `controls changed between the published versions: ${(artifact.controlRegression || []).join(', ')}`);
  assert.deepEqual(Object.keys(artifact.controlsDetail).sort(), [...CONTROLS].sort());
});

test('the artifact quotes no host path', () => {
  assert.equal(artifact.hostPathLeak, false,
    'research/ is committed — an artifact that prints this host\'s paths must never be committed');
});

test('the committed artifact is the one the tool derives — re-run it and it must agree', async () => {
  // The artifact must be reproducible, not narrated: re-run the TOOL and
  // compare the verdict and the counts (not measuredAt — time moves). This
  // is also the leg that makes the mutation ladder able to catch a probe,
  // a tool or an artifact that drifts from what the channel really says.
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const fresh = path.join(os.tmpdir(), `answer-voice-published-fresh-${process.pid}.json`);
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
