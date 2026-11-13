// The two-tree measurement pin for the count-from-header fix (13.11 PULS
// AE, the card's standing next step 1):
//   research/hadro-count-from-header-2026-11-13.json
//
// What this file pins, in the order that would hurt most if it lied:
//
//   * the committed artifact is byte-for-byte what the tool derives RIGHT
//     NOW from the committed fixtures and git history (no hand-edited
//     numbers) — the prefix tree ea074c4 is extracted by `git archive`, so
//     the pre-fix face is provable forever, not narrated;
//   * the DELTA is the measured one: the prefix tree decoded 72 of 144 (72
//     refused with a garbage number, 72 EMPTY curves, 0 header-count
//     matches), this tree decodes 144 of 144 (0 refused, 0 empty, 144
//     header-count matches);
//   * the GUARD face is measured, not asserted: the same IDL shape under
//     another address keeps the strict u32-prefix codec, and the rule leaks
//     nowhere;
//   * falsification: the garbage vector length MUST be present in the
//     prefix face — a prefix tree that shows no defect makes the fix
//     unmeasurable, and the tool says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-hadro-count-from-header.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'hadro-count-from-header-2026-11-13.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

test('the artifact is what the tool derives from history right now (no hand-edited numbers)', () => {
  const fresh = path.join(ROOT, 'research', '.hadro-count-from-header-fresh.json');
  try {
    execFileSync(process.execPath, [TOOL, '--out', fresh], {
      cwd: ROOT, stdio: 'ignore', timeout: 600_000,
    });
    assert.ok(existsSync(fresh), 'the tool produced no output');
    const produced = JSON.parse(readFileSync(fresh, 'utf8'));
    const strip = (r) => { const copy = { ...r }; delete copy.measuredAt; return copy; };
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

test('the prefix tree showed the defect and the fix landed on the measured numbers', () => {
  assert.equal(artifact.prefix.commit, 'ea074c4');
  const prefix = artifact.prefix.face;
  assert.equal(prefix.total, 144);
  assert.equal(prefix.decoded, 72);
  assert.equal(prefix.refused, 72);
  assert.equal(prefix.emptyPoints, 72,
    'the pre-fix face decoded EMPTY curves — the label hid the defect');
  assert.equal(prefix.pointsMatchHeaderCount, 0);
  assert.ok(Object.keys(prefix.refusalReasons).some((reason) => /vector length/.test(reason)),
    'the pre-fix refusal must carry the garbage vector length — the falsification that proves the prefix is the pre-fix tree');
  const worktree = artifact.worktree.face;
  assert.equal(worktree.decoded, 144);
  assert.equal(worktree.refused, 0);
  assert.equal(worktree.emptyPoints, 0);
  assert.equal(worktree.pointsMatchHeaderCount, 144);
  assert.equal(worktree.pointsMismatchHeaderCount, 0);
  assert.equal(worktree.describedByteExact, 144,
    'every curve payload explains its prefix byte-exactly and reports the 8-byte tail');
  assert.deepEqual(artifact.delta, {
    decoded: 72, refused: -72, emptyPoints: -72, pointsMatchHeaderCount: 144,
  });
});

test('the guard face is measured: the rule belongs to the program it was measured on', () => {
  const guard = artifact.guard;
  assert.equal(guard.ruleLeaked, false,
    'the named count-from-header voice must never answer for an interface the table does not name');
  assert.equal(guard.otherAddressKeepsStrictCodec, true,
    'the same IDL shape under another address keeps the strict u32-prefix codec');
  assert.equal(guard.otherNameKeepsStrictCodec, true,
    'a renamed instruction keeps the strict codec too');
});

test('every falsification count is zero and the limits are written down', () => {
  assert.deepEqual(artifact.falsifications, [], 'the artifact itself reports falsifications');
  assert.equal(artifact.ok, true);
  const limits = artifact.limits.join(' | ');
  assert.match(limits, /sequence tail .* stays REPORTED as trailing/,
    'the 8-byte tail the IDL does not declare must be named as unexplained, not invented');
  assert.match(limits, /keyed to the measured program address/,
    'the address gate must be stated in the artifact itself');
});

test('falsification: the tool turns NO VERDICT when its prefix commit is unreachable', () => {
  const result = execFileSyncSafe(process.execPath,
    [TOOL, '--prefix', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      '--out', path.join(ROOT, 'research', '.hadro-count-falsify.json')]);
  assert.equal(result.status, 3, `an unreachable prefix must answer exit 3, got ${result.status}`);
  rmSync(path.join(ROOT, 'research', '.hadro-count-falsify.json'), { force: true });
});

function execFileSyncSafe(command, args) {
  try {
    const stdout = execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 120_000 });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}
