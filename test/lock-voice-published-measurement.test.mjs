// test/lock-voice-published-measurement.test.mjs — the published-channel
// claim is pinned by an artifact, and every claim in it can go red.
//
// WHAT THIS PINS (research/lock-voice-published-2026-11-17.json, produced by
// tools/measure-lock-voice-published.mjs):
//
// Two PUBLISHED npm versions were installed into two EMPTY apps and the same
// byte-identical probe was run inside each installed package:
//
//   sememe@0.4.34 — the tag the README pinned before this fix — 13 of 13
//     lock-surface refusals answered WITHOUT a code, 13 of 13 without a
//     repair, and 2 refusals minted a code the CLI then dropped.
//   sememe@0.4.35 — 0/0/0, 0 wrong channel, 0 control regressions.
//
// WHY A PUBLISHED MEASUREMENT AND NOT ONLY A TWO-TREE ONE: the two-tree tool
// compares two commits in this repository. It cannot say what a stranger
// gets, and "fixed on main, still broken behind the pinned release" is the
// most repeated defect class in this repository's history.
//
// FALSIFICATION: every count here is checked against its own meaning — the
// carrier MUST show the defect (a baseline without a defect makes the fix
// unmeasurable), the fixed version MUST NOT, and the tool must have
// installed the versions it claims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACT = path.join(ROOT, 'research', 'lock-voice-published-2026-11-17.json');
const TOOL = path.join(ROOT, 'tools', 'measure-lock-voice-published.mjs');

const artifact = existsSync(ARTIFACT) ? JSON.parse(readFileSync(ARTIFACT, 'utf8')) : null;

test('the artifact names the tool that produced it, and that tool exists', () => {
  assert.ok(artifact, 'the measurement artifact is missing');
  assert.equal(artifact.tool, 'tools/measure-lock-voice-published.mjs');
  assert.ok(existsSync(TOOL), 'the measuring tool is missing');
  assert.ok(existsSync(path.join(ROOT, 'tools', 'lock-voice-probe.mjs')),
    'the byte-identical probe both packages run is missing');
});

test('the tool really installed the two versions it claims to have measured', () => {
  assert.ok(artifact, 'the measurement artifact is missing');
  assert.equal(artifact.carrier.requested, '0.4.34');
  assert.equal(artifact.carrier.installed, '0.4.34',
    'the carrier must be the version it claims — an install that resolved elsewhere measures nothing');
  assert.equal(artifact.fixed.requested, '0.4.35');
  assert.equal(artifact.fixed.installed, '0.4.35',
    'same for the fixed version: a pin that silently resolved to an older release would make the claim vacuous');
});

test('the verdict HOLDS: the carrier shows the defect, the fixed version does not', () => {
  assert.ok(artifact, 'the measurement artifact is missing');
  assert.equal(artifact.verdictName, 'lock-voice-held-on-the-published-channel',
    `the published channel must hold the claim: ${artifact.verdictName}`);

  const v = artifact.verdict;
  // The baseline must show the defect, or the fix is unmeasurable.
  assert.ok(v.carrierUnnamedFaces > 0,
    'sememe@0.4.34 must show unnamed refusals: a baseline with no defect makes the fix unmeasurable');
  assert.ok(v.carrierRepairlessFaces > 0, 'and repairless refusals');
  assert.ok(v.carrierSilentCodeFaces > 0,
    'and at least one refusal that minted a code the CLI dropped — that is the narrowest of the four faults');

  // The fixed version must show none of them.
  assert.equal(v.fixedUnnamedFaces, 0, 'sememe@0.4.35 must name every refusal');
  assert.equal(v.fixedRepairlessFaces, 0, 'and repair every one');
  assert.equal(v.fixedWrongChannelFaces, 0, 'and keep them on the work channel (exit 1)');
  assert.equal(v.fixedSilentCodeFaces, 0, 'and never mint a code the channel drops');
  assert.equal(v.controlRegression, 0, 'no control may answer differently between the two versions');
});

test('the detail agrees with the counts: every face actually differs as claimed', () => {
  assert.ok(artifact, 'the measurement artifact is missing');
  const faces = artifact.faces;
  assert.ok(faces.length >= 13, `the measurement must cover the whole surface, got ${faces.length}`);

  for (const name of faces) {
    const row = artifact.detail[name];
    assert.ok(row, `the detail must name ${name}`);
    // The carrier shows the defect on THIS face…
    assert.equal(row.carrier.code, null,
      `sememe@0.4.34 must answer ${name} without a code (measured defect), got ${row.carrier.code}`);
    assert.equal(row.carrier.fix, null, `and without a repair: ${name}`);
    assert.equal(row.carrier.exit, 1, `and on the work channel: ${name}`);
    // …and the fixed version does not.
    assert.ok(typeof row.fixed.code === 'string' && row.fixed.code.length > 0,
      `sememe@0.4.35 must name ${name}: got ${JSON.stringify(row.fixed.code)}`);
    assert.ok(row.fixed.fix && /^fix: /.test(row.fixed.fix),
      `and carry a repair for ${name}: got ${JSON.stringify(row.fixed.fix)}`);
    assert.equal(row.fixed.exit, 1, `and keep the work channel for ${name}`);
  }
});

test('the silent-code class is measured on both versions', () => {
  assert.ok(artifact, 'the measurement artifact is missing');
  assert.ok(artifact.silentCode.carrier.length > 0,
    'the carrier must show at least one code minted without a repair (receipt-integrity refusals on 0.4.34)');
  assert.deepEqual(artifact.silentCode.fixed, [],
    'the fixed version must mint no repairless code');
  for (const name of artifact.silentCode.carrier) {
    assert.ok(typeof name === 'string' && name.length > 0,
      'the silent faces must be named');
  }
});

test('the control rows recorded in the artifact really agree between the two versions', () => {
  assert.ok(artifact, 'the measurement artifact is missing');
  const rows = artifact.controlsDetail;
  assert.ok(rows && Object.keys(rows).length === artifact.controls.length,
    'every control must have recorded rows for both versions');
  let regressions = 0;
  for (const name of artifact.controls) {
    const row = rows[name];
    assert.ok(row && row.carrier && row.fixed, `${name} must have both rows`);
    const sameExit = row.carrier.exit === row.fixed.exit;
    const sameCode = (row.carrier.code ?? null) === (row.fixed.code ?? null);
    const sameAnswered = row.carrier.answered === row.fixed.answered;
    if (!sameExit || !sameCode || !sameAnswered) regressions += 1;
  }
  assert.equal(regressions, 0,
    'a control that answered differently between two published versions means the two packages differ somewhere the verdict does not describe');
  assert.equal(artifact.verdict.controlRegression, 0,
    'and the verdict must record the same thing the rows show');
});

test('the committed artifact is the one the tool derives — re-run it and it must agree', async () => {
  // The artifact must be reproducible, not narrated: re-run the TOOL and
  // compare the verdict and counts (not measuredAt — time moves).
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const fresh = path.join(os.tmpdir(), `lock-voice-published-fresh-${process.pid}.json`);
  try {
    const res = spawnSync(process.execPath, [TOOL, '--out', fresh], {
      cwd: ROOT, encoding: 'utf8', timeout: 1200000,
    });
    // exit 0 = the fresh run holds the claim; exit 1 = the claim is FALSE now.
    const produced = existsSync(fresh) ? JSON.parse(readFileSync(fresh, 'utf8')) : null;
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
    try { (await import('node:fs')).rmSync(fresh, { force: true }); } catch { /* temp file, ignore */ }
  }
});
