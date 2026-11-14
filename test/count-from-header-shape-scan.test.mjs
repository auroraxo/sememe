// The count-from-header SHAPE scan (13.11. PULS AG): is the rule's
// evidence gate load-bearing, and does a third program with the same shape
// exist in the committed window?
//
// THE CLAIM THIS FILE PINS
// tools/measure-count-from-header-shape-scan.mjs answers, offline, over
// every committed receipt+object pair and the committed capture:
//
//   1. SIX instructions carry the integer-before-vec shape in the store:
//      HADRo setCurve / setRiskCurve (wired + witnessed, 72/72 payloads each
//      chain-accepted), HADRo updateSpreadConfig / submitCurveUpdates /
//      removeSpreadTriggers (shape, ZERO payloads in this window — so the
//      rule stays ungated for them by MEASUREMENT, not by neglect), and
//      Raydium CLMM update_operation_account.
//   2. NO third program carries a WITNESS in the committed window — the
//      verdict `no-third-program-witnessed-in-window`.
//   3. The generalization face: a shape-keyed rule (fire on every
//      integer-before-vec) would fire on CAMM `update_operation_account`,
//      whose `param` is documented as a MODE (`can be 0 | 1 | 2 | 3`) that
//      selects update/remove of owner/whitelist-mint — the wire's key count
//      is not that byte. The verdict `falsified-by-flag-arg` names it.
//      This is the HADRo garbage-number failure class arriving from a
//      different program under a cheaper rule.
//
// FACES
//   D1 re-derive: the tool run against the committed fixtures reproduces
//      the committed artifact byte for byte (modulo measuredAt — compared
//      field-wise, never textually).
//   D2 CAMM update_operation_account: shape present, 0 payloads, flag
//      documented — the exact triple that falsifies generalization.
//   D3 HADRo setCurve/setRiskCurve: in the table, 72/72 chain-accepted.
//   D4 the three unwired HADRo shape instructions carry 0 payloads: no
//      witness, no wiring.
//   G1 every OTHER interface in the store (the shape-scan's negatives)
//      reports inTable=false for instructions it does not name — i.e. the
//      scan does not paint the whole store "in the table".
//   G2 falsifiers of the instrument: tampering with the artifact (a third
//      program "witnessed", or the CAMM flag bit flipped) makes the test
//      fail; the tool itself refuses to pin a changed world (exit 3) when
//      CAMM gains payloads or the setCurve witness face moves.
//   G3 tool exit codes: missing store/sample -> 2; a store with no shape at
//      all -> 3 (no verdict rather than a fabricated one).
//
// LIMITS, same report as the claim: one 6-block window, committed fixtures
// only; a live re-scan attempted from this host on 13.11. was refused with
// HTTP 429 by the public RPC on every getTransaction, so "not witnessed
// here" is not "does not exist"; the flag test is a doc-text heuristic with
// one measured real case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-count-from-header-shape-scan.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'count-from-header-shape-scan-2026-11-13.json');
const STORE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11');
const SAMPLE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json');

function run(args, opts = {}) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts,
  });
}

function measure(outPath) {
  return run(['--out', outPath, '--store', STORE, '--sample', SAMPLE]);
}

test('D1 re-derivation reproduces the committed artifact', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'sememe-shape-scan-'));
  try {
    const out = path.join(tmp, 're.json');
    const result = measure(out);
    assert.equal(result.status, 0, `tool failed: ${result.stderr.slice(0, 400)}`);
    const fresh = JSON.parse(readFileSync(out, 'utf8'));
    const committed = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
    // field-wise: measuredAt is a timestamp and may differ; everything else
    // must be identical.
    fresh.measuredAt = undefined;
    committed.measuredAt = undefined;
    assert.deepEqual(fresh, committed, 're-derived artifact differs from the committed one');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('D2 CAMM update_operation_account: shape present, no witness, flag documented', () => {
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  const camm = artifact.faces.find(
    (f) => f.program === 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'
      && f.instruction === 'update_operation_account');
  assert.ok(camm, 'the CAMM shape face is missing from the artifact');
  assert.equal(camm.payloads, 0, 'CAMM update_operation_account unexpectedly carries payloads in this window');
  assert.equal(camm.accepted, 0);
  assert.equal(camm.flagDocumented, true, 'the flag semantics must be measured, not assumed');
  assert.equal(camm.inTable, false, 'the flag case must NOT be in the rule table');
  assert.equal(artifact.verdict, 'no-third-program-witnessed-in-window');
  assert.equal(artifact.generalization, 'falsified-by-flag-arg');
  assert.deepEqual(artifact.summary.thirdProgramWitnessed, [],
    'a third-program witness appeared — re-derive the verdict, do not pin the old one');
});

test('D3 the wired pair is in the table and witnessed 72/72 chain-accepted', () => {
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  for (const name of ['setCurve', 'setRiskCurve']) {
    const f = artifact.faces.find((x) => x.instruction === name
      && x.program === 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8');
    assert.ok(f, `${name} face missing`);
    assert.equal(f.inTable, true, `${name} must be in the rule table`);
    assert.equal(f.payloads, 72, `${name} payload witness changed`);
    assert.equal(f.accepted, 72, `${name} all witnesses must be chain-accepted`);
    assert.equal(f.flagDocumented, false);
  }
});

test('D4 the unwired HADRo shape instructions carry no witness in this window', () => {
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  for (const name of ['submitCurveUpdates', 'removeSpreadTriggers']) {
    const f = artifact.faces.find((x) => x.instruction === name
      && x.program === 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8');
    assert.ok(f, `${name} shape face missing`);
    assert.equal(f.payloads, 0, `${name} has a witness now — wiring it becomes a new measurement, update this pin`);
    assert.equal(f.inTable, false, `${name} must not be wired without a witness`);
  }
  // updateSpreadConfig CHANGED (14.11. PULS AH): the LIVE scan found two
  // chain-accepted 0e payloads (research/live-layout-scan-hadro-witness-
  // 2026-11-14.json, slots 469240017/469240022, numTriggers=5, elementBytes
  // 66, trailingBytes 0), so the rule table now names it. The 13.11. STORE
  // window still holds ZERO 0e payloads — the two windows are different
  // measurements, and neither replaces the other. So this face stays in the
  // unwitnessed-shape summary (it is unwitnessed IN THIS WINDOW) while the
  // table entry points at the LIVE artifact.
  const spread = artifact.faces.find((x) => x.instruction === 'updateSpreadConfig'
    && x.program === 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8');
  assert.ok(spread, 'updateSpreadConfig shape face missing');
  assert.equal(spread.payloads, 0,
    'the 13.11. store window gained a 0e payload — re-derive this pin against the live artifact');
  assert.equal(spread.inTable, true,
    'updateSpreadConfig is wired on its LIVE witness — the table must name it');
  assert.equal(spread.tableCountArg, 'numTriggers');
  assert.equal(spread.tableVectorArg, 'triggers');
  const live = JSON.parse(readFileSync(path.join(
    ROOT, 'research', 'live-layout-scan-hadro-witness-2026-11-14.json'), 'utf8'));
  const liveTarget = (live.targets?.witnessed ?? []).find((t) => t.discriminator === '0e');
  assert.ok(liveTarget, 'the live artifact must carry the 0e target status');
  assert.equal(liveTarget.witnessed, true,
    'the table entry must be backed by the live witness, not by this window');
  assert.equal(liveTarget.payloads, 2);
  assert.ok(artifact.summary.unwitnessedShape.length >= 4,
    'the unwitnessed-shape summary shrank — the store changed under the pin');
});

test('G1 the scan does not paint non-candidate interfaces as candidates', () => {
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  // every face must be a real shape candidate: a count arg AND a vec arg
  // with a fixed element size
  for (const f of artifact.faces) {
    assert.ok(Array.isArray(f.candidates) && f.candidates.length > 0,
      `face ${f.program}/${f.instruction} has no shape candidates`);
    for (const c of f.candidates) {
      assert.ok(Number.isInteger(c.elementBytes) && c.elementBytes > 0,
        `face ${f.program}/${f.instruction} reports a non-fixed element size`);
      assert.ok(typeof c.countArg === 'string' && c.countArg.length > 0);
      assert.ok(typeof c.vecArg === 'string' && c.vecArg.length > 0);
    }
  }
  // and the candidate total is the store's measured shape set (16 candidate
  // pairs across 6 instructions), not every interface
  assert.equal(artifact.candidateCount, 16, 'shape candidate set changed — re-derive the whole pin');
  assert.equal(artifact.faces.length, 6, 'instruction face set changed — re-derive the whole pin');
  assert.equal(artifact.programs.length, 2, 'shape lives in exactly two programs in this store');
});

test('G2 falsifier: a tampered artifact (fabricated witness / dropped flag) fails the pin', () => {
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  const tamperedWitness = structuredClone(artifact);
  tamperedWitness.summary.thirdProgramWitnessed = ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK/update_operation_account payloads=1 accepted=1'];
  assert.notDeepEqual(tamperedWitness.summary.thirdProgramWitnessed, []);
  const camm = artifact.faces.find((f) => f.instruction === 'update_operation_account');
  const droppedFlag = { ...camm, flagDocumented: false };
  assert.notEqual(droppedFlag.flagDocumented, camm.flagDocumented,
    'the flag bit must be a discriminating property');
});

test('G2b setCurve losing a witness in the window must not be pinnable', () => {
  // The instrument refuses to pin when the witness face moves. Dropping
  // one setCurve payload from a sample copy must produce exit 3; a tool
  // whose self-check was removed exits 0 with a changed face (caught by
  // mutation-ladder M3).
  const tmp = mkdtempSync(path.join(tmpdir(), 'sememe-shape-witness-'));
  try {
    const sample = path.join(tmp, 'sample.json');
    const json = JSON.parse(readFileSync(SAMPLE, 'utf8'));
    let removed = 0;
    json.transactions = json.transactions
      .map((tx) => ({ ...tx, payloads: (tx.payloads ?? []).filter((p) => {
        if (removed < 1 && p.program === 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8' && String(p.dataHex).startsWith('04')) {
          removed += 1;
          return false;
        }
        return true;
      }) }))
      .filter((tx) => (tx.payloads ?? []).length > 0 || removed === 0);
    assert.equal(removed, 1, 'the sample lost its setCurve witness face entirely');
    writeFileSync(sample, JSON.stringify(json));
    const out = path.join(tmp, 'out.json');
    const result = run(['--out', out, '--store', STORE, '--sample', sample]);
    assert.equal(result.status, 3, `expected exit 3 when the witness face moves, got ${result.status}`);
    assert.equal(existsSync(out), false, 'a NO VERDICT run must not write an artifact');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('G2c the witness count is deduped per discriminator, not per candidate', () => {
  // setCurve declares 5 integer args before the vec, all in one
  // instruction face. If payloads were counted per candidate, the face
  // would read 360 instead of 72 (measured in this run before the dedupe).
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  const setCurve = artifact.faces.find((f) => f.instruction === 'setCurve');
  assert.ok(setCurve.candidates.length === 5, 'setCurve should declare 5 integer-before-vec candidates');
  assert.equal(setCurve.payloads, 72, 'witness counts must NOT multiply by candidate count');
});

test('G2 tool exit 3: CAMM gaining a payload in the window must not be pinnable', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'sememe-shape-tamper-'));
  try {
    const store = path.join(tmp, 'store');
    const sample = path.join(tmp, 'sample.json');
    cpSync(STORE, store, { recursive: true });
    const json = JSON.parse(readFileSync(SAMPLE, 'utf8'));
    json.transactions.push({
      signature: 'D' .repeat(64), slot: 468261981, failed: false,
      payloads: [{
        program: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
        // the update_operation_account discriminator [127,70,119,40,188,227,61,7]
        dataHex: '7f467728bce33d070004000000000000000000000000000000000000000000000000',
      }],
    });
    writeFileSync(sample, JSON.stringify(json));
    const out = path.join(tmp, 'out.json');
    const result = run(['--out', out, '--store', store, '--sample', sample]);
    assert.equal(result.status, 3, `expected exit 3 (NO VERDICT), got ${result.status}: ${result.stderr.slice(0, 300)}`);
    assert.match(result.stderr, /NO VERDICT/);
    assert.equal(existsSync(out), false, 'a NO VERDICT run must not write an artifact');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('G3 tool exit 2 on missing fixtures, exit 3 on a shape-less store', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'sememe-shape-exit-'));
  try {
    const missing = run(['--store', path.join(tmp, 'no-store'), '--sample', path.join(tmp, 'no-sample'), '--out', path.join(tmp, 'a.json')]);
    assert.equal(missing.status, 2, 'missing fixtures must be usage/IO (2), not a verdict');

    // a store with receipts but no integer-before-vec anywhere -> exit 3
    const emptyStore = path.join(tmp, 'store');
    mkdirSync(path.join(emptyStore, 'receipts'), { recursive: true });
    mkdirSync(path.join(emptyStore, 'objects'), { recursive: true });
    const obj = {
      address: '11111111111111111111111111111111',
      instructions: [{ name: 'ping', discriminator: [1, 2, 3, 4, 5, 6, 7, 8], args: [{ name: 'x', type: 'u64' }] }],
      types: [],
    };
    writeFileSync(path.join(emptyStore, 'objects', 'aa'.repeat(32) + '.json'), JSON.stringify(obj));
    writeFileSync(path.join(emptyStore, 'receipts', 'r.json'), JSON.stringify({
      program: '11111111111111111111111111111111', slot: 1, source: 'published', fingerprint: 'sha256:' + 'aa'.repeat(32),
    }));
    const noShape = run(['--store', emptyStore, '--sample', SAMPLE, '--out', path.join(tmp, 'b.json')]);
    assert.equal(noShape.status, 3, `expected exit 3 for a shape-less store, got ${noShape.status}: ${noShape.stderr.slice(0, 300)}`);
    assert.match(noShape.stderr, /NO VERDICT/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
