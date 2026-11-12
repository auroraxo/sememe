// The two-tree measurement pin for the raw-LE PRODUCT WIRING (12.11. PULS Z):
//   research/rawle-product-2026-11-12.json
//
// What this file asserts, in order of what would hurt most if it lied:
//
//   * the committed artifact is byte-for-byte what the tool derives RIGHT
//     NOW from git history and the committed fixtures (no hand-edited
//     numbers), except the timestamp;
//   * the artifact names NO host path (a machine path in a committed
//     measurement makes it non-reproducible and would rot in CI);
//   * the PREFIX tree (the PULS Y engine commit) SHOWED the pre-wiring
//     face: the engine exists but the product refuses — 0/102 decoded,
//     named refusals at every boundary, the store loop closed (adopt
//     refused, decode no-object). A baseline that shows no change makes
//     the wiring unmeasurable;
//   * THIS tree lands on the wired numbers: 102/102 decoded and 102/102
//     byte-exact re-encoded at the product entry, 5/5 refusals as
//     CodecError faces (one family — no RawLeError leak, no crash),
//     derivation passes with NO Anchor table, idlDialect 'raw-le',
//     adopt/read/union open under the interface's own id, the CLI store
//     loop end-to-end (adopt + 2/2 decode);
//   * the guards hold: Whirlpool unchanged, a file that defeats BOTH
//     engines keeps the exact PULS X named refusal (code
//     unsupported-idl-dialect) at codec AND union, mislabelling under a
//     foreign program id stays refused with 'via program_id';
//   * every falsification count is zero and the verdict is 'measured'.
//
// The tool-side falsification half lives in the tool itself: it exits 3
// NO VERDICT when the pin hash disagrees with the caller's file, when the
// sample's wire face moved, or when either tree does not land on the
// pinned faces.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-rawle-product.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'rawle-product-2026-11-12.json');
const DIABLO = 'DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z';

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

test('the artifact carries no host path', () => {
  const text = readFileSync(ARTIFACT, 'utf8');
  assert.doesNotMatch(text, /\/home\//, 'a committed measurement must not name a home directory');
  assert.doesNotMatch(text, /\/tmp\//, 'a committed measurement must not name a scratch path');
});

test('the prefix tree SHOWED the pre-wiring face: engine present, product refusing', () => {
  // The prefix is the FIRST commit that carries src/rawle.mjs — the PULS Y
  // baseline (engine capability, product boundary untouched).
  assert.equal(artifact.prefix.commit, '05e6643ca2a171b19e72d3a7f7b37e8fa68561bb',
    'the prefix is the engine commit 05e6643 (PULS Y)');
  const prefix = artifact.faces.prefix;
  assert.equal(prefix.decode.decoded, 0, 'pre-wiring the product entry decodes 0/102');
  assert.equal(prefix.decode.voice, 'named', 'pre-wiring the product answers the PULS X named refusal');
  assert.equal(prefix.wire.idlDialect, 'unsupported');
  assert.equal(prefix.wire.derivation, 'named', 'pre-wiring the derivation gate refuses the file');
  assert.equal(prefix.wire.storeAdopt, 'refused');
  assert.equal(prefix.wire.storeRead, 'refused');
  assert.equal(prefix.wire.union, 'refused');
  assert.equal(prefix.store.adopt, 'refused', 'pre-wiring `sememe adopt` refuses the file');
  assert.equal(prefix.store.decode, 'no-object', 'pre-wiring there is nothing to decode through the store');
  assert.equal(prefix.guards.mislabelAdopted, false, 'the re-labelling gate was already closed');
});

test('this tree lands on the wired numbers at the product entry', () => {
  const current = artifact.faces.current;
  assert.equal(current.decode.decoded, 102, 'the product entry decodes every committed payload');
  assert.equal(current.decode.byteExact, 102, 'the same entry re-encodes every payload byte-identically');
  assert.equal(current.decode.voice, 'decoded');
  assert.equal(current.union.decodeData, 'decoded', 'decodeData answers through the engine too');
});

test('one refusal family: every product-level refusal is a CodecError face', () => {
  const family = artifact.faces.current.family;
  const labels = [
    'unknownTag', 'truncatedPayload', 'trailingByte',
    'encodeUnknownInstruction', 'encodeMissingArgument',
  ];
  assert.deepEqual(Object.keys(family).sort(), [...labels].sort(), 'all five faces are measured');
  for (const label of labels) {
    assert.equal(family[label], 'named-codec-error',
      `${label} must come back as the codec's own named CodecError (RawLeError stays inside the engine)`);
  }
});

test('every boundary lets the engine answer, and no Anchor table is derived', () => {
  const wire = artifact.faces.current.wire;
  assert.equal(wire.derivation, 'passes', 'the derivation gate passes an engine-readable file');
  assert.deepEqual(wire.derivationFilled, { instructions: 0, events: 0 },
    'NO sighash fill for a tag-dispatch dialect — the PULS X fill defect stays dead');
  assert.equal(wire.idlDialect, 'raw-le', 'idlDialect names the wired dialect, not unsupported');
  assert.equal(wire.storeAdopt, 'adopts');
  assert.equal(wire.storeRead, 'reads');
  assert.equal(wire.union, 'decoded');
});

test('the guards hold: no widening, mislabelling still refused', () => {
  const guards = artifact.faces.current.guards;
  assert.equal(guards.whirlpool, 'decoded-or-reported', 'Anchor interfaces decode unchanged');
  assert.equal(guards.brokenDialect, 'named',
    'a file that defeats BOTH engines keeps the PULS X named refusal at the codec');
  assert.equal(guards.brokenDialectCode, 'unsupported-idl-dialect');
  assert.equal(guards.brokenDialectUnion, 'named', 'and the same refusal at the union boundary');
  assert.equal(guards.mislabelAdopted, false,
    'adopt under a foreign program id stays refused even with the dialect gate opened');
  assert.match(String(guards.mislabelRefusal), /via program_id/);
});

test('the user store loop: adopt + decode end-to-end', () => {
  const store = artifact.faces.current.store;
  assert.equal(store.adopt, 'adopts');
  assert.equal(store.decode, 'decoded');
  assert.equal(store.decoded, 2);
  assert.equal(store.total, 2);
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
  assert.equal(artifact.faces.prefix.wireFace['01:118'], 34, 'both probes read the same committed sample');
});

test('the pin is the upstream file as measured, and its bytes are not vendored', () => {
  assert.equal(artifact.pin.commit, 'f5005ac4c401cbb88dcb7c8e249b6dfe119f13dc');
  assert.equal(artifact.pin.license, null, 'no license at the pin — that is WHY the bytes are not committed');
  assert.equal(artifact.pin.file, 'sdk/diabloarb-executor.idl.json');
  assert.match(artifact.pin.canonicalFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(existsSync(path.join(ROOT, 'test', 'fixtures', 'diabloarb-executor-idl.json')), false,
    'the interface must never be committed');
});

test('the artifact is what the tool derives from history right now (no hand-edited numbers)', async (t) => {
  // Re-derivation needs the pinned source file, which is NOT vendored —
  // fetched at the pin over the network like the PULS X measurement,
  // skipped by NAME when gh is not authenticated (CI must not silently
  // pass a hand-edited artifact: the offline pins above still decide on
  // every field, only the byte-identical re-run is network-gated).
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    await run('gh', ['auth', 'status'], { timeout: 15000 });
  } catch {
    t.skip('gh CLI not authenticated; skipping full re-derivation');
    return;
  }
  const { stdout } = await run('gh', ['api',
    `repos/cryptodiablo/diabloarb/contents/sdk/diabloarb-executor.idl.json?ref=${artifact.pin.commit}`,
    '-H', 'Accept: application/vnd.github.raw'], { timeout: 60000, maxBuffer: 8 << 20 });
  const fresh = path.join(ROOT, 'research', '.rawle-product-fresh.json');
  const source = path.join(ROOT, 'research', `.rawle-product-pin-${process.pid}.json`);
  try {
    await writeFile(source, stdout);
    execFileSync(process.execPath, [TOOL, '--source', source, '--out', fresh], {
      cwd: ROOT, stdio: 'ignore', timeout: 600_000,
    });
    assert.ok(existsSync(fresh), 'the tool produced no output');
    const produced = JSON.parse(readFileSync(fresh, 'utf8'));
    const strip = (r) => { const c = { ...r }; delete c.generatedAt; return c; };
    assert.deepEqual(strip(produced), strip(artifact),
      'the committed artifact is not what the tool measures — re-run the tool and commit its output');
  } finally {
    rmSync(fresh, { force: true });
    rmSync(source, { force: true });
  }
});

test('tool falsification: no arguments exits 2 with usage', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await assert.rejects(run('node', [TOOL], { cwd: ROOT }), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /usage: measure-rawle-product/);
    return true;
  });
});

test('tool falsification: a tampered source exits 3 with the pin hash mismatch', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const scratch = path.join(ROOT, 'research', `.tamper-rawle-product-${process.pid}.json`);
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
    rmSync(scratch, { force: true });
  }
});
