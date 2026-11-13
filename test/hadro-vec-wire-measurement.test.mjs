// The measurement pin for the HADRo vec-wire investigation (13.11. PULS AD,
// the card's standing next step "HADRo setRiskCurve 72 bleiben benannte
// Verweigerungen"):
//   research/hadro-vec-wire-2026-11-13.json
//
// What this file pins, in the order that would hurt most if it lied:
//
//   * P (the PRODUCT face) — sememe today decodes 72 of the 144 committed
//     HADRo payloads and REFUSES the other 72 with a nonsense number
//     ("vector length 1814753837 needs 38109830577 byte(s)"), because the
//     stored IDL declares `points: vec` (Borsh length prefix) while the
//     wire carries none. The 72 it "decodes" are setCurve payloads with an
//     EMPTY point list and 46 trailing bytes — described, not decoded.
//     These refusals are named, not noise; the artifact pins the exact
//     refusal family and instruction.
//   * W (the WIRE face) — the real layout is 1-byte discriminator + a u8
//     header (numPoints at byte offset 4) + numPoints x 21-byte
//     CurvePointInput + an 8-byte `sequence: u64` tail. Fitting that layout
//     re-encodes 144/144 payloads BYTE-EXACT, and the sequence tail equals
//     the containing transaction's slot (108) or slot-1 (36) in 144/144 —
//     a count that does not line up by chance across 144 chain-accepted
//     payloads.
//   * S (the FIRST-PARTY source) — Hadron-Fi/hadron-tx-verifier
//     idl/hadron.json at sha256 219f44fb… (Apache-2.0 + MIT in the same
//     repo) declares the two trailing `sequence: u64` args the on-chain
//     metadata IDL is missing, and NOTHING else differs: same
//     CurvePointInput, same discriminators.
//
// The honest limit is pinned too: the first-party source ALSO declares
// `points` as a Borsh vec, so adopting it alone would fix the tail and
// still refuse every payload. The prefix question is closed by the
// arithmetic in W, not by the source. No product code is changed by this
// pulse — the 72 refusals and the 72 empty-points decodes still stand.
//
// Falsification half (this file): the artifact's numbers are the ones the
// tool derives RIGHT NOW from the committed fixture (same convention as
// test/hadro-short-discriminator-measurement.test.mjs); the artifact names
// no host path; every pinned invariant turns the test red when the artifact
// is tampered with; the tool exits 3 when its source pin moves.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-hadro-vec-wire.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'hadro-vec-wire-2026-11-13.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

function ghAuthed() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch { return false; }
}

test('the artifact is what the tool derives from the committed fixtures right now (no hand-edited numbers)', { skip: ghAuthed() ? false : 'gh CLI not authenticated; the re-derivation needs the pinned first-party IDL over the network (named skip, same class as the other pin tests)' }, () => {
  const fresh = path.join(ROOT, 'research', '.hadro-vec-wire-fresh.json');
  try {
    execFileSync(process.execPath, [TOOL, '--out', fresh], {
      cwd: ROOT, stdio: 'ignore', timeout: 300_000,
    });
    assert.ok(existsSync(fresh), 'the tool produced no output');
    const produced = JSON.parse(readFileSync(fresh, 'utf8'));
    const strip = (r) => { const c = { ...r }; delete c.measuredAt; return c; };
    assert.deepEqual(strip(produced), strip(artifact),
      'the committed artifact is not what the tool measures — re-run the tool and commit its output');
  } finally {
    rmSync(fresh, { force: true });
  }
});

test('the artifact carries no host path', () => {
  const text = readFileSync(ARTIFACT, 'utf8');
  assert.doesNotMatch(text, /\/home\//, 'a committed measurement must not name a home directory');
  assert.doesNotMatch(text, /\/tmp\//, 'a committed measurement must not name a scratch path');
});

test('P — the product face: 72 decoded (empty curve), 72 refused with a named family', () => {
  const p = artifact.productFace;
  assert.equal(p.total, 144);
  assert.equal(p.decoded, 72);
  assert.equal(p.refused, 72);
  assert.equal(p.byteExact, 0,
    'no HADRo payload is byte-exact through the product path today');
  assert.equal(p.setCurveEmptyPoints, 72,
    'the 72 "decodes" carry an EMPTY curve — the label must not be sold as decoded');
  assert.equal(p.setCurveTrailingHexes['92'], 72,
    'every described decode carries the same 46-byte trailing run');
  assert.deepEqual(p.refusalReasons, { 'vector length <n> needs <n> byte(s)': 72 },
    'the refusal family must be uniform and named');
  assert.deepEqual(p.refusalInstruction, { setRiskCurve: 72 },
    'the refusals must all be setRiskCurve');
  assert.match(p.examples.refusal.message, /vector length 1814753837/,
    'the pinned garbage count is the evidence that no Borsh prefix exists on the wire');
  assert.equal(p.examples.refusal.message.includes('decode refused by the only stored source'), true,
    'the refusal must name its source');
});

test('W — the wire face: the header-count layout fits and re-encodes 144/144 byte-exact', () => {
  const w = artifact.wireFace;
  assert.equal(w.total, 144);
  assert.equal(w.fit, 144, 'every payload fits the header-count layout');
  assert.equal(w.byteExact, 144, 'every payload re-encodes byte-identically');
  assert.equal(w.witnessAccepted, 144,
    'every payload in the committed sample is chain-accepted (failed:false)');
  assert.equal(w.sequenceSlot, 108);
  assert.equal(w.sequenceSlotMinus1, 36);
  assert.equal(w.sequenceOther, 0,
    'the sequence tail is the slot or slot-1 in EVERY payload — not a coincidence');
  assert.equal(w.sequenceSlot + w.sequenceSlotMinus1, 144);
  assert.equal(w.byInstruction.setCurve.payloads, 72);
  assert.equal(w.byInstruction.setCurve.byteExact, 72);
  assert.equal(w.byInstruction.setRiskCurve.payloads, 72);
  assert.equal(w.byInstruction.setRiskCurve.byteExact, 72);
  assert.deepEqual(w.byInstruction.setCurve.numPointsHistogram, { 2: 72 },
    'setCurve always carries exactly two points');
});

test('S — the first-party source adds exactly the two sequence args and nothing else', () => {
  const s = artifact.sourceFace;
  assert.equal(s.repo, 'Hadron-Fi/hadron-tx-verifier');
  assert.equal(s.sha256, '219f44fb63729232b3685fbde49a817b0c8321a0203dcca68c88370fbed1279e');
  assert.equal(s.licenses['LICENSE-APACHE'], true);
  assert.equal(s.licenses['LICENSE-MIT'], true);
  const diff = s.diffAgainstStoredIdl;
  assert.equal(diff.differences.length, 2, 'exactly two instructions differ');
  assert.deepEqual(diff.differences.map((d) => d.instruction).sort(), ['setCurve', 'setRiskCurve']);
  for (const difference of diff.differences) {
    assert.equal(difference.kind, 'args-differ');
    assert.deepEqual(difference.storedOnly, [], 'the source adds args, it does not remove any');
    assert.deepEqual(difference.sourceOnly, [['sequence', 'u64']].map((e) => JSON.stringify(e)),
      'the only added arg is the trailing sequence: u64');
    assert.equal(difference.discriminatorEqual, true);
  }
  assert.equal(diff.curvePointInputEqual, true,
    'the 21-byte CurvePointInput shape is identical in source and store');
  assert.equal(diff.sourceInstructionCount, 38);
});

test('the honest limits are written down: adopting the source alone would still refuse everything', () => {
  assert.equal(artifact.verdict, 'hadro-vec-wire-no-borsh-prefix');
  const limits = artifact.limits.join(' | ');
  assert.match(limits, /no product code changed/,
    'the 72 refusals and the 72 empty-points decodes still stand after this pulse');
  assert.match(limits, /ALSO declares points as a Borsh vec/,
    'the first-party source does NOT close the prefix question');
  assert.match(limits, /count-from-header/,
    'the fix face (count from the header, encoder half, refusal voice) is named as owed');
  assert.equal(artifact.committedStoreModified, false,
    'the committed store must be byte-untouched by the measurement run');
});
