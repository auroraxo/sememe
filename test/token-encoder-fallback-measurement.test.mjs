// The two-tree measurement pin for the encoder-fallback fix (15.11. PULS AN):
//   research/token-encoder-fallback-2026-11-15.json
//
// What this file pins, in the order that would hurt most if it lied:
//
//   * the committed artifact is byte-for-byte what the tool derives RIGHT
//     NOW from the committed fixtures and git history (no hand-edited
//     numbers) — the prefix tree e28c849 is extracted by `git archive`, so
//     the pre-fix face is provable forever, not narrated;
//   * the DELTA is the measured one: the prefix tree refused all FIVE
//     advertised metadata names (unknown-variant), re-encoded 0 of 10
//     committed mainnet payloads and 0 of 4 chain-witnessed oracle payloads,
//     and printed its refusal reason TWICE; this tree refuses none of the
//     53 advertised names, re-encodes 10/10 and 4/4 byte-exactly, and names
//     the reason once;
//   * the GUARD face is measured, not asserted: legacy SPL Token has no
//     fallback branch and refuses every metadata name on BOTH trees;
//   * falsification: the prefix tree MUST show the defect — a prefix tree
//     that shows no defect makes the fix unmeasurable, and the tool says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-token-encoder-fallback.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'token-encoder-fallback-2026-11-15.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

test('the artifact is what the tool derives from history right now (no hand-edited numbers)', () => {
  const fresh = path.join(ROOT, 'research', '.token-encoder-fallback-fresh.json');
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
  assert.equal(artifact.prefix.commit, 'e28c849');
  const prefix = artifact.prefix.face;
  assert.deepEqual(prefix.unknownVariantNames,
    ['Initialize', 'UpdateField', 'RemoveKey', 'UpdateAuthority', 'Emit'],
    'the pre-fix face refused every advertised metadata name');
  assert.equal(prefix.fixtureReencoded, '0/10');
  assert.equal(prefix.fixtureRefusals['unknown-variant'], 10);
  assert.equal(prefix.oracleReencoded, '0/4');
  assert.equal(prefix.oracleRefusals['unknown-variant'], 4);
  assert.equal(prefix.reasonDoubled, true,
    'the pre-fix voice printed the refusal reason twice — the falsification that proves the prefix is the pre-fix tree');

  const worktree = artifact.worktree.face;
  assert.deepEqual(worktree.unknownVariantNames, [],
    'no advertised name may be refused as unknown');
  assert.equal(worktree.fixtureReencoded, '10/10');
  assert.deepEqual(worktree.fixtureRefusals, {});
  assert.equal(worktree.oracleReencoded, '4/4');
  assert.deepEqual(worktree.oracleRefusals, {});
  assert.equal(worktree.reasonDoubled, false);
  assert.equal(worktree.namesAdvertised, 53, '48 token variants + 5 metadata variants');
  assert.equal(worktree.metadataNamesAdvertised, 5);
  assert.equal(artifact.verdict, 'encoder-reproduces-its-own-names');
  assert.deepEqual(artifact.falsifications, []);
});

test('the guard face holds on both trees: legacy SPL Token has no fallback', () => {
  for (const [tree, face] of [['prefix', artifact.prefix.face], ['worktree', artifact.worktree.face]]) {
    assert.deepEqual(Object.keys(face.legacySPLToken).sort(),
      ['Emit', 'Initialize', 'RemoveKey', 'UpdateAuthority', 'UpdateField'],
      `${tree}: the guard face must cover all five metadata names`);
    for (const [name, outcome] of Object.entries(face.legacySPLToken)) {
      assert.equal(outcome, 'unknown-variant',
        `${tree}: legacy SPL Token must refuse ${name}, got ${outcome}`);
    }
  }
});

test('the artifact names its own limits', () => {
  assert.ok(Array.isArray(artifact.limits) && artifact.limits.length >= 3,
    'a measurement must carry its limits');
  const text = artifact.limits.join(' ');
  assert.match(text, /not a live foreign consumer/,
    'the limit must say that no foreign consumer ran this');
});
