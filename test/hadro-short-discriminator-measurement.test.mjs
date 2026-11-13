// The two-tree measurement pin for the short-discriminator fix.
//
// What this file asserts, in order of what would hurt most if it lied:
//
//   * the committed artifact is byte-for-byte what the tool derives RIGHT NOW
//     from the committed fixtures and git history (no hand-edited numbers);
//   * the artifact names NO host path (a machine path in a committed
//     measurement makes it non-reproducible and would rot in CI);
//   * the pre-fix tree SHOWED THE DEFECT (prefixShowsNoDefect false with the
//     measured 0/195 — a baseline that shows no defect makes the fix
//     unmeasurable, so the pin is on the falsification being counted);
//   * every falsification count is zero — including the surgical guards:
//     pump.fun, pfeeU and Eternal verdicts byte-identical between trees;
//   * the delta is the measured one: +195 decoded (123 through the stored
//     discriminators, the final 72 through count-from-header on 2026-11-13),
//     +38 preserved, false -> true on both unit faces;
//   * the honest limits are written down: the worktree face decodes all 195,
//     and the 8-byte sequence tail is reported as trailing, not invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-hadro-short-discriminator.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'hadro-short-discriminator-2026-11-12.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

test('the artifact is what the tool derives from history right now (no hand-edited numbers)', () => {
  const fresh = path.join(ROOT, 'research', '.hadro-short-discriminator-fresh.json');
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

test('the pre-fix tree showed the defect and the fix landed on the pinned numbers', () => {
  assert.equal(artifact.prefix.commit, 'c304e80');
  assert.equal(artifact.falsifications.prefixShowsNoDefect, false,
    'the baseline must SHOW the defect (pre-fix: 0/195 decoded, 0/38 preserved)');
  const prefixWire = artifact.faces.prefix.wire.hadro;
  assert.equal(prefixWire.decoded, 0, 'pre-fix the product path decoded nothing');
  assert.equal(prefixWire.refused, 195);
  assert.equal(artifact.faces.prefix.hadroStore.shortDiscriminatorsPreserved, 0);
  assert.equal(artifact.faces.prefix.unit.preservesShortInstruction, false);
  assert.equal(artifact.falsifications.landedOnPinnedNumbers, true);
  assert.deepEqual(artifact.falsifications.landed, []);
  assert.equal(artifact.delta.hadroWireDecoded, 195);
  assert.equal(artifact.delta.hadroShortDiscriminatorsPreserved, 38);
  assert.equal(artifact.delta.unitPreservesShortInstruction, 'false -> true');
  assert.equal(artifact.delta.unitPreservesShortEvent, 'false -> true');
});

test('every falsification count is zero — the surgical guards hold', () => {
  const f = artifact.falsifications;
  assert.equal(f.refusalsNotNamed, 0, 'all 72 refusals are the named setRiskCurve disagreement');
  assert.deepEqual(f.guardMoves, [], 'no face without short discriminators moved between trees');
  assert.deepEqual(f.pinMoves, [], 'pump.fun 400/442/249, pfeeU 5/459, Eternal 227/15/227 stay pinned');
  assert.equal(f.etrnPreservedPostFix, true, 'Eternal keeps its 76 short event discriminators too');
  assert.equal(f.etrnConflictsStable, true, 'the two genuine 8-byte conflicts are unchanged');
  assert.equal(artifact.ok, true);
});

test('the honest limits are written down, not smoothed over', () => {
  const limits = artifact.honestLimits;
  assert.match(limits.setRiskCurve, /count-from-header rule closed them/,
    'the 72 refusals this measurement pinned were closed by the 2026-11-13 layout rule — stated, not hidden');
  assert.match(limits.setCurve, /sequence tail/,
    'the described-exact decodes must not be sold as full byte-exact');
  assert.match(limits.etrnEvents, /measurable effect none/,
    'preservation without wire effect is stated as such');
  // And the wire face itself keeps the split honest:
  const hadro = artifact.faces.worktree.wire.hadro;
  assert.equal(hadro.decoded, 195);
  assert.equal(hadro.fullExact, 51);
  assert.equal(hadro.describedExact, 144);
  assert.equal(hadro.refused, 0);
  assert.equal(hadro.fullExact + hadro.describedExact, hadro.decoded,
    'every decode is either full or described byte-exact — nothing else counts');
});
