// The two-tree measurement pin for the non-Anchor dialect gate (12.11. PULS X):
//   research/dialect-named-refusal-2026-11-12.json
//
// What this file asserts, in order of what would hurt most if it lied:
//
//   * the committed artifact is byte-for-byte what the tool derives RIGHT
//     NOW from git history and the committed fixtures (no hand-edited
//     numbers), except the timestamp;
//   * the artifact names NO host path (a machine path in a committed
//     measurement makes it non-reproducible and would rot in CI);
//   * the pre-fix tree SHOWED every defect face — the TypeError crash voice
//     over all 102 payloads, the sighash fill (4/0), a successful adopt
//     under the interface's OWN id and under WSOL's id, and an open read
//     boundary — a baseline that shows no defect makes the fix unmeasurable;
//   * every falsification count is zero, including the surgical guards
//     (Whirlpool/Kamino pass, 22/22 committed store objects readable);
//   * the delta is the measured one: crash -> named (CodecError),
//     102 crash -> 0 crash / 102 no-interface (countable), fill -> refused,
//     adopt true -> false on both ids, readable -> named.
//
// The tool-side falsification half lives in the tool itself: it exits 3
// NO VERDICT when the pin hash disagrees with the caller's file, when the
// sample's wire face moved, when the coverage artifact stopped carrying the
// 102-payload face, when the prefix tree shows no defect, or when this
// tree does not land on the pinned numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-dialect-named-refusal.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'dialect-named-refusal-2026-11-12.json');
const COVERAGE = path.join(ROOT, 'research', 'ecosystem-coverage-2026-11-11.json');
const DIABLO = 'DiabLokxisGR8P4Qqp2QL6PmBhhVsdzPstCE4WoLxc5z';

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

test('the artifact carries no host path', () => {
  const text = readFileSync(ARTIFACT, 'utf8');
  assert.doesNotMatch(text, /\/home\//, 'a committed measurement must not name a home directory');
  assert.doesNotMatch(text, /\/tmp\//, 'a committed measurement must not name a scratch path');
});

test('the prefix tree SHOWED the defect on every face, and this tree landed on the pinned numbers', () => {
  assert.equal(artifact.prefix.commit, 'aa6901bdc5e3b4cc5f8fad0831e5ff79557fdd3d',
    'the prefix is the commit before the fix — aa6901b (pre-fix main)');
  const prefix = artifact.faces.prefix;
  const current = artifact.faces.current;
  // Face 1: the crash voice.
  assert.match(String(prefix.direct.codecCrashVoice), /is not iterable/,
    'pre-fix the codec CRASHED with the unnamed TypeError');
  assert.equal(prefix.adopt.voices.crash, 102, 'pre-fix all 102 payloads refused with the crash voice');
  assert.equal(current.direct.codecCrashVoice, null, 'post-fix the crash voice is gone');
  assert.match(String(current.direct.codecNamedVoice), /^unsupported IDL dialect:/);
  assert.equal(current.direct.codecNamedIsCodecError, true, 'the named refusal is a CodecError, not a bare Error');
  assert.equal(current.adopt.voices.crash, 0);
  assert.equal(current.adopt.voices['no-interface'], 102,
    'the honest product answer with a refused interface is a COUNTABLE no-interface state');
  // Face 2: the derivation.
  assert.deepEqual(prefix.direct.derivationFilled, { instructions: 4, events: 0 },
    'pre-fix the derivation filled all four tag-dispatch instructions with sighashes');
  assert.match(String(current.direct.derivationRefused), /^unsupported IDL dialect:/);
  assert.equal(current.direct.derivationFilled, null);
  // Face 3: both mislabelling paths.
  assert.equal(prefix.adopt.voiceAdopted, true, 'pre-fix adopt under the OWN id succeeded');
  assert.equal(prefix.adopt.mislabelAdopted, true, 'pre-fix adopt under WSOL succeeded — the re-labelling defect');
  assert.equal(prefix.readBoundary.voice, 'readable',
    'pre-fix the store reader admitted a dialect the codec could not read');
  assert.equal(current.adopt.voiceAdopted, false);
  assert.match(String(current.adopt.voiceAdoptRefusal), /unsupported IDL dialect/);
  assert.equal(current.adopt.mislabelAdopted, false);
  assert.match(String(current.adopt.mislabelAdoptRefusal), /via program_id/, 'the refusal names the field that carried the declaration');
  assert.equal(current.readBoundary.voice, 'named');
});

test('every falsification count is zero — the surgical guards hold', () => {
  const f = artifact.falsifications;
  const nonZero = Object.entries(f).filter(([, v]) => v !== 0);
  assert.deepEqual(nonZero, [], 'every falsification face must be counted and zero');
  assert.equal(artifact.ok, true);
  assert.equal(artifact.verdict, 'measured');
});

test('the delta is the measured one', () => {
  assert.match(artifact.delta.directCodecVoice, /crash \(TypeError\) -> named/);
  assert.match(artifact.delta.storeVoices, /crash 102 -> crash 0, no-interface 102/);
  assert.equal(artifact.delta.derivationFill, '{"instructions":4,"events":0} -> refused');
  assert.equal(artifact.delta.adoptUnderOwnId, 'true -> false');
  assert.equal(artifact.delta.mislabelAdopted, 'true -> false');
  assert.equal(artifact.delta.readBoundary, 'readable -> named');
});

test('the artifact\'s baselines match the committed fixtures (no hand-edited numbers)', () => {
  const coverage = JSON.parse(readFileSync(COVERAGE, 'utf8'));
  const entry = coverage.programs.find((p) => p.program === DIABLO);
  const queued = coverage.acquisitionQueue.find((q) => q.program === DIABLO);
  assert.equal(entry.payloads, 102);
  assert.equal(entry.decoded, 0);
  assert.equal(entry.noInterface, 102);
  assert.equal(entry.acquirable, false);
  assert.equal(queued.acquirable, false);
  assert.equal(artifact.faces.current.adopt.payloads, entry.payloads);
  // The wire face: tag 01 + the six length classes, summed.
  assert.equal(artifact.face.reduce((sum, f) => sum + f.count, 0), 102);
  assert.deepEqual(artifact.face.map((f) => [f.tag, f.length, f.count]), [
    ['01', 104, 14], ['01', 118, 34], ['01', 138, 27],
    ['01', 165, 3], ['01', 171, 5], ['01', 182, 19],
  ]);
});

test('the pin is the upstream file as measured, and its bytes are not vendored', () => {
  assert.equal(artifact.pin.commit, 'f5005ac4c401cbb88dcb7c8e249b6dfe119f13dc');
  assert.equal(artifact.pin.license, null, 'no license at the pin — that is WHY the bytes are not committed');
  assert.equal(artifact.pin.file, 'sdk/diabloarb-executor.idl.json');
  assert.match(artifact.pin.canonicalFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(artifact.pin.rawSha256, 'ce582b4fbb67c9fc72b8189ad9873a183cb1aa49c920ddb6b0614820ee6165ce');
  assert.equal(existsSync(path.join(ROOT, 'test', 'fixtures', 'diabloarb-executor-idl.json')), false,
    'the interface must never be committed');
});

test('tool falsification: no arguments exits 2 with usage', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await assert.rejects(run('node', [TOOL], { cwd: ROOT }), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /usage: measure-dialect-named-refusal/);
    return true;
  });
});

test('tool falsification: a tampered source exits 3 with the pin hash mismatch', async () => {
  const { writeFile, rm } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const scratch = path.join(ROOT, 'research', `.tamper-dialect-${process.pid}.json`);
  try {
    await writeFile(scratch, JSON.stringify({
      name: 'diabloarb_executor_tampered',
      program_id: DIABLO,
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

test('tool falsification: a non-diabloarb file exits 3 at the program gate', async () => {
  const { writeFile, rm } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const scratch = path.join(ROOT, 'research', `.notdiablo-${process.pid}.json`);
  try {
    // A structurally faithful dialect copy under ANOTHER program id: the
    // dialect premise still holds, so execution reaches the program gate.
    await writeFile(scratch, JSON.stringify({
      name: 'not_diablo',
      program_id: 'So11111111111111111111111111111111111111112',
      types: { Hop: { size: 5, fields: [] } },
      instructions: [{ name: 'search', tag: 1, data: [{ name: 'tag', type: 'u8', value: 1 }] }],
    }));
    await assert.rejects(run('node', [TOOL, '--source', scratch], { cwd: ROOT }), (error) => {
      assert.equal(error.code, 3);
      assert.match(error.stderr, /pin-hash-mismatch|declares program_id/);
      return true;
    });
  } finally {
    await rm(scratch, { force: true });
  }
});

test('the artifact is what the tool derives from history right now (no hand-edited numbers)', async (t) => {
  // Re-derivation needs the pinned source file, which is NOT vendored —
  // fetched at the pin over the network like the archer/pump pins, skipped
  // by NAME when gh is not authenticated (CI must not silently pass a
  // hand-edited artifact: the offline pins above still decide on every
  // field, only the byte-identical re-run is network-gated).
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
  const fresh = path.join(ROOT, 'research', '.dialect-named-refusal-fresh.json');
  const source = path.join(ROOT, 'research', `.dialect-pin-${process.pid}.json`);
  try {
    const { writeFile, rm } = await import('node:fs/promises');
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
