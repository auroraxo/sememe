// The two-tree measurement pin for the raw-LE dialect engine (12.11. PULS Y):
//   research/rawle-decoder-2026-11-12.json
//
// What this file asserts, in order of what would hurt most if it lied:
//
//   * the committed artifact is byte-for-byte what the tool derives RIGHT
//     NOW from git history and the committed fixtures (no hand-edited
//     numbers), except the timestamp;
//   * the artifact names NO host path (a machine path in a committed
//     measurement makes it non-reproducible and would rot in CI);
//   * the PRE-FIX tree had no engine and CRASHED with an unnamed TypeError
//     — a baseline that shows no defect makes the engine unmeasurable;
//   * this tree decodes 102/102 and re-encodes 102/102 byte-identically;
//   * every one of the 8 grammar falsifications refused BY NAME (never the
//     sentinel ESCAPED);
//   * the PRODUCT boundary is UNCHANGED **in the tree this artifact
//     measured** (PULS Y): the named refusal from src/dialect.mjs was the
//     product's answer — the engine was capability, the wiring future
//     work. Since PULS Z the boundary IS wired; this artifact stays the
//     frozen pre-wiring baseline, and the wired faces are measured by
//     research/rawle-product-2026-11-12.json (test/rawle-product-measurement.test.mjs);
//   * every falsification count is zero and the verdict is 'measured'.
//
// The tool-side falsification half lives in the tool itself: it exits 3
// NO VERDICT when the pin hash disagrees with the caller's file, when the
// sample's wire face moved, or when this tree does not land on the pinned
// numbers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-rawle-decoder.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'rawle-decoder-2026-11-12.json');
const DIABLO = 'DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z';

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

test('the artifact carries no host path', () => {
  const text = readFileSync(ARTIFACT, 'utf8');
  assert.doesNotMatch(text, /\/home\//, 'a committed measurement must not name a home directory');
  assert.doesNotMatch(text, /\/tmp\//, 'a committed measurement must not name a scratch path');
});

test('the pre-fix tree had NO engine and CRASHED — the baseline shows the defect', () => {
  assert.equal(artifact.prefix.commit, 'aa6901bdc5e3b4cc5f8fad0831e5ff79557fdd3d');
  assert.equal(artifact.prefix.enginePresent, false, 'the prefix tree carries no src/rawle.mjs');
  assert.equal(artifact.prefix.productVoice, 'crash', 'pre-fix the product crashed with the unnamed TypeError');
});

test('this tree decodes 102/102 and reproduces every payload byte-identically', () => {
  const engine = artifact.faces.current.engine;
  assert.equal(engine.present, true);
  assert.equal(engine.dialectReason, null, 'the pinned interface is inside the declared grammar');
  assert.equal(engine.decoded, 102);
  assert.equal(engine.byteExact, 102);
  assert.deepEqual(engine.refusalFaces, [], 'no payload may be refused: the engine explains all 102');
});

test('every grammar falsification refused BY NAME (no ESCAPED sentinel)', () => {
  const grammar = artifact.faces.current.engine.grammar;
  const labels = [
    'mutatedFixedSize', 'duplicateTag', 'counterNotAPrecedingField',
    'unknownDispatchTag', 'truncatedPayload', 'trailingByte',
    'noEncodingDeclaration', 'layoutlessStubTag',
  ];
  for (const label of labels) {
    const value = grammar[label];
    assert.equal(typeof value, 'string', `${label} must record a refusal`);
    assert.notEqual(value, 'ESCAPED', `${label} ESCAPED — the mutant was accepted`);
    assert.ok(value.length > 10, `${label} must name the reason`);
  }
  // The gate falsifications must state a NAMED reason, not just any message.
  assert.match(grammar.duplicateTag, /named: duplicate instruction tag/);
  assert.match(grammar.counterNotAPrecedingField, /named: .*counter .* is not a preceding field/);
  assert.match(grammar.noEncodingDeclaration, /named: no little-endian encoding declaration/);
  assert.match(grammar.mutatedFixedSize, /declared size 32 does not equal the field sum 24/);
  assert.match(grammar.unknownDispatchTag, /unknown instruction tag 0x07/);
  assert.match(grammar.trailingByte, /trailing bytes after search/);
  assert.match(grammar.layoutlessStubTag, /declares no field list/);
});

test('the PRODUCT boundary is unchanged — the engine did not wire itself in', () => {
  // HISTORICAL RECORD of the PULS Y run: in THAT tree the product still
  // refused by name. Since PULS Z the boundary is wired and the product
  // face of a fresh run is 'decoded' — that state is measured by
  // research/rawle-product-2026-11-12.json (test/rawle-product-measurement).
  // This artifact stays the pre-wiring baseline and is pinned as measured.
  assert.equal(artifact.faces.current.product.voice, 'named');
  assert.match(artifact.faces.current.product.message, /^unsupported IDL dialect:/);
  assert.equal(artifact.faces.prefix.product.voice, 'crash');
  assert.match(artifact.delta.productVoice, /unchanged named refusal/);
});

test('every falsification count is zero and the verdict is measured', () => {
  const nonZero = Object.entries(artifact.falsifications).filter(([, v]) => v !== 0);
  assert.deepEqual(nonZero, [], 'every falsification face must be counted and zero');
  assert.equal(artifact.ok, true);
  assert.equal(artifact.verdict, 'measured');
});

test('the artifact\'s baselines match the committed fixtures (no hand-edited numbers)', () => {
  assert.equal(artifact.face.reduce((sum, f) => sum + f.count, 0), 102);
  assert.deepEqual(artifact.face.map((f) => [f.tag, f.length, f.count]), [
    ['01', 104, 14], ['01', 118, 34], ['01', 138, 27],
    ['01', 165, 3], ['01', 171, 5], ['01', 182, 19],
  ]);
  assert.equal(artifact.faces.current.wireFace['01:118'], 34);
});

test('the pin is the upstream file as measured, and its bytes are not vendored', () => {
  assert.equal(artifact.pin.commit, 'f5005ac4c401cbb88dcb7c8e249b6dfe119f13dc');
  assert.equal(artifact.pin.license, null, 'no license at the pin — that is WHY the bytes are not committed');
  assert.equal(artifact.pin.file, 'sdk/diabloarb-executor.idl.json');
  assert.match(artifact.pin.canonicalFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(existsSync(path.join(ROOT, 'test', 'fixtures', 'diabloarb-executor-idl.json')), false,
    'the interface must never be committed');
});

test('tool falsification: no arguments exits 2 with usage', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await assert.rejects(run('node', [TOOL], { cwd: ROOT }), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /usage: measure-rawle-decoder/);
    return true;
  });
});

test('tool falsification: a tampered source exits 3 with the pin hash mismatch', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const scratch = path.join(ROOT, 'research', `.tamper-rawle-${process.pid}.json`);
  try {
    await writeFile(scratch, JSON.stringify({
      name: 'diabloarb_executor_tampered',
      program_id: DIABLO,
      encoding: 'little-endian',
      types: { Hop: { size: 5, fields: [] } },
      instructions: [{ name: 'search', tag: 1, data: [{ name: 'tag', type: 'u8', value: 1 }] }],
    }));
    await assert.rejects(run('node', [TOOL, '--source', scratch], { cwd: ROOT }), (error) => {
      assert.equal(error.code, 3);
      assert.match(error.stderr, /diabloarb-pin-hash-mismatch/);
      return true;
    });
  } finally {
    await rm(scratch, { force: true });
  }
});
