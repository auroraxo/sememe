// test/acquire-voice-published-measurement.test.mjs — the DELIVERY
// measurement of the acquisition voice, asked at the CHANNEL.
//
// This file pins the committed artifact of
// tools/measure-acquire-voice-published.mjs:
//
//   research/acquire-voice-published-2026-11-18.json
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE WORKING-TREE MEASUREMENT
// (test/acquire-voice.test.mjs):
//   The working-tree measurement asks whether THIS code answers. It cannot
//   say what a stranger receives. This repo's most-repeated defect class is
//   exactly that gap — "main fixed, the pin pointing behind it" — so two
//   PUBLISHED npm versions are installed into two empty apps (with the
//   optional peer @solana/web3.js, which the pull path needs) and the SAME
//   byte-identical probe (tools/acquire-voice-probe.mjs) runs inside each
//   installed package.
//
// WHAT THE MEASUREMENT FOUND:
//
//   sememe@0.4.36 (the version the README pinned until v0.4.37) answers
//   every RPC failure of `sememe pull` as bare prose: 9 of 9 faces carry
//   NO code and NO repair — {"error":"RPC unavailable: HTTP 429"} and the
//   parser's / undici's / web3.js's words, quoted verbatim.
//
//   sememe@0.4.37 answers all 9 with their own code, the endpoint as
//   subject and a repair — and on the channel that follows what ran: exit 2
//   when nothing was dispatched (non-https URL, bad program id), exit 1 when
//   the request went out and the answer failed.
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
const ARTIFACT = path.join(ROOT, 'research', 'acquire-voice-published-2026-11-18.json');
const TOOL = path.join(ROOT, 'tools', 'measure-acquire-voice-published.mjs');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

const FACES = [
  'rpcHttp403', 'rpcHttp429', 'rpcHttp500', 'rpcGarbageBody', 'rpcJsonError',
  'rpcShortResult', 'rpcUnreachable', 'rpcNotHttps', 'rpcBadProgramId',
];
const CONTROLS = ['pullOk', 'gapUnknownHolds', 'storeAnswerVoice', 'flagVoice'];
const EXPECTED_EXIT = {
  rpcNotHttps: 2, rpcBadProgramId: 2,
  rpcHttp403: 1, rpcHttp429: 1, rpcHttp500: 1, rpcGarbageBody: 1,
  rpcJsonError: 1, rpcShortResult: 1, rpcUnreachable: 1,
  pullOk: 0, gapUnknownHolds: 3, storeAnswerVoice: 1, flagVoice: 2,
};

test('the artifact measures two installed versions and reaches a verdict', () => {
  assert.equal(artifact.carrier.installed, artifact.carrier.requested,
    'the carrier version must be the one actually installed from the registry');
  assert.equal(artifact.fixed.installed, artifact.fixed.requested,
    'the fixed version must be the one actually installed from the registry');
  assert.notEqual(artifact.carrier.requested, artifact.fixed.requested,
    'a comparison against itself measures nothing');
  assert.equal(artifact.verdictName, 'acquire-voice-held-on-the-published-channel');
});

test('the OLDER published version carries the defect — a clean baseline would not prove anything', () => {
  assert.ok(artifact.carrierUnnamedFaces.length > 0,
    'the published carrier must refuse without a code somewhere, otherwise the fix is unprovable');
  assert.equal(artifact.carrierUnnamedFaces.length, FACES.length,
    'all nine faces refused unnamed on the carrier');
  assert.equal(artifact.carrierRepairlessFaces.length, FACES.length,
    'and all nine without a repair');
  for (const face of FACES) {
    assert.equal(artifact.detail[face].carrier.code, null,
      `${face} must refuse without a code on sememe@${artifact.carrier.version}`);
    assert.equal(artifact.detail[face].carrier.fix, null,
      `and without a repair: ${face}`);
  }
});

test('the NEWER published version names every refusal and repairs it', () => {
  assert.equal(artifact.fixedUnnamedFaces.length, 0,
    'every refusal must carry a product code on the fixed published version');
  assert.equal(artifact.fixedRepairlessFaces.length, 0,
    'every refusal must carry a repair');
  for (const face of FACES) {
    const row = artifact.detail[face].fixed;
    assert.ok(row.code, `${face} must carry a code: ${JSON.stringify(row)}`);
    assert.ok(row.fix, `${face} must carry a repair: ${JSON.stringify(row)}`);
  }
});

test('the CHANNEL follows what ran — usage 2, work 1, and the controls keep theirs', () => {
  assert.equal(artifact.fixedWrongChannelFaces.length, 0,
    `a face left its channel: ${artifact.fixedWrongChannelFaces.join(', ')}`);
  for (const face of FACES) {
    assert.equal(artifact.detail[face].fixed.exit, EXPECTED_EXIT[face],
      `${face} must answer on exit ${EXPECTED_EXIT[face]}`);
  }
  for (const control of CONTROLS) {
    assert.equal(artifact.controlsDetail[control].fixed.exit, EXPECTED_EXIT[control],
      `${control} must keep exit ${EXPECTED_EXIT[control]}`);
  }
});

test('the third parties\' words never reach the operator on the published channel', () => {
  for (const face of FACES) {
    const row = artifact.detail[face].fixed;
    assert.doesNotMatch(row.error, /fetch failed|Unexpected token|is not valid JSON/,
      `${face} quotes the parser/transport: ${row.error}`);
    assert.doesNotMatch(row.error, /Non-base58 character|Invalid public key input/,
      `${face} quotes web3.js: ${row.error}`);
  }
});

test('the endpoint\'s own JSON-RPC message survives on the published channel', () => {
  const row = artifact.detail.rpcJsonError.fixed;
  assert.match(row.error, /node is behind, please try a healthy node/,
    `the endpoint's own message must be quoted, not dropped: ${row.error}`);
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
  // The artifact must be reproducible, not narrated: re-run the TOOL (two
  // npm installs + the probe in each installed package) and compare the
  // verdict and the counts. This is the leg that makes the mutation ladder
  // able to catch a probe, a tool or an artifact that drifts from what the
  // channel really says — without it, M1/M2 would mutate code nothing reads.
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const fresh = path.join(os.tmpdir(), `acquire-voice-published-fresh-${process.pid}.json`);
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
