// Pin: test/shipped-readme-pin.test.mjs
//
// The defect this pins (measured 2026-11-15): the one-pin rule was enforced
// on the CHECKOUT's README by eight gates and on NOTHING that leaves the
// machine. Publishing is manual — `npm publish` ran from release commit
// 729bbaa, whose README carried TWO install pins (`#v0.4.28` in the install
// blocks, `#v0.4.27` in the channel-parity paragraph), npm accepted it, and
// only AFTERWARDS did CI go red on that same commit (runs 43741650634 +
// 43741650472, both failure). The gate that should have refused the publish
// ran after it.
//
// `sememe@0.4.28` is npm `latest` and ships that ambiguous README: a stranger
// on the npm package page is told to install two different tags.
//
// WHAT THE PIN HOLDS (each face turns the test red):
//
//   D1 the artifact names the tool that produced it, and the tool exists
//   D2 the artifact's verdict is the DEFECTIVE one and its counts agree
//      with its own rows (a clean verdict here would be a lie: 0.4.28 and
//      0.4.23 are published with two pins)
//   D3 the artifact names the live defect: 0.4.28 — npm `latest` — carries
//      two pins, and it names both of them
//   D4 the artifact carries no host path (a scratch directory on THIS
//      machine is not reproducible evidence) and states its limits
//   D5 THIS tree's own packed tarball is clean — the fix is real, not only
//      named
//   D6 package.json wires `prepublishOnly` to the gate: the refusal now
//      stands IN FRONT of the publish instead of behind it. This is the face
//      that is RED on the pre-fix tree.
//   G1 the gate's judgement refuses a two-pin README and passes a one-pin
//      one (the rule, as a pure function)
//   G2 `npm pack` does NOT run the gate — the channel-parity tool packs
//      every historical tag, several of which carry two pins forever, and
//      the gate must not make that history unmeasurable
//   G3 the gate's source still refuses (it must not have been softened into
//      a warning)
//
// The live re-run is NOT part of this pin (it needs the npm registry and
// minutes of wall clock). The pin holds the committed artifact and the
// gate's shape; the pulse that produced the artifact is the one that ran it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACT = path.join(ROOT, 'research', 'shipped-readme-pin-2026-11-19.json');
const TOOL = path.join(ROOT, 'tools', 'measure-shipped-readme-pin.mjs');
const GATE = path.join(ROOT, 'tools', 'gate-shipped-readme-pin.mjs');

const artifact = existsSync(ARTIFACT) ? JSON.parse(readFileSync(ARTIFACT, 'utf8')) : null;

test('D1: the artifact names the tool that produced it, and that tool exists', () => {
  assert.ok(artifact, 'the measurement artifact is missing');
  assert.equal(artifact.tool, 'tools/measure-shipped-readme-pin.mjs');
  assert.ok(existsSync(TOOL), 'the measuring tool is missing');
  assert.ok(existsSync(GATE), 'the publishing gate is missing');
});

test('D2: the artifact records the DEFECTIVE verdict and its counts agree with its rows', () => {
  assert.ok(artifact, 'the measurement artifact is missing');
  assert.equal(artifact.verdict, 'shipped-readme-pin-defective');
  const rows = artifact.versions;
  const twoPins = rows.filter((r) => r.verdict === 'two-pins');
  assert.equal(artifact.counts.twoPins, twoPins.length, 'the two-pins count must match the rows');
  assert.equal(artifact.counts.measured, rows.filter((r) => r.verdict !== 'no-verdict').length);
  assert.equal(
    artifact.counts.measured,
    artifact.counts.clean + artifact.counts.twoPins + artifact.counts.wrongTag + artifact.counts.noPin,
    'every measured row must be classified exactly once',
  );
  assert.ok(twoPins.length > 0, 'the artifact claims a defect but names none');
});

test('D3: the defect is named forever, and the CURRENT latest is clean', () => {
  assert.ok(artifact, 'the measurement artifact is missing');

  // The named history: 0.4.28 was npm `latest` when this defect was found and
  // its two pins are immutable — this face must stay true for every future
  // release, so it does not depend on what `latest` happens to be today.
  const defective = artifact.versions.find((r) => r.version === '0.4.28');
  assert.ok(defective, 'the artifact does not measure 0.4.28');
  assert.equal(defective.verdict, 'two-pins', '0.4.28 must be recorded as carrying two pins');
  assert.ok(defective.pins.includes('v0.4.28'), 'the artifact must name the release pin');
  assert.ok(defective.pins.includes('v0.4.27'), 'the artifact must name the second, wrong pin');
  // The ambiguity is in the SHIPPED bytes. The npm page is measured once, at
  // package level, because npm serves one readme for the whole package —
  // asserting a per-version page/tarball agreement for 0.4.28 would be
  // asserting something npm does not provide.
  assert.equal(defective.pageIsPackageLevel, true,
    'the artifact must record that npm served a package-level readme for this version, not a per-version one');

  const page = artifact.packageLevelPageReadme;
  assert.ok(page, 'the artifact does not record the package-level page readme');
  assert.equal(page.agreesWithNewestTarball, true,
    `the npm page pins ${JSON.stringify(page.pins)} but the newest tarball ships something else`);

  // The live invariant: whatever is published NEWEST must carry exactly one
  // correct pin. This is what the prepublishOnly gate guarantees, so the
  // measurement must show it holding — a two-pin release was published again.
  const releases = artifact.versions.filter((r) => /^\d+\.\d+\.\d+$/.test(r.version) && r.verdict !== 'no-verdict');
  assert.ok(releases.length >= 2, 'record too short to be a record');
  const newest = releases[releases.length - 1];
  assert.equal(newest.verdict, 'clean',
    `the newest published version ${newest.version} ships ${JSON.stringify(newest.pins)} — the gate let a two-pin README publish`);
});

test('D4: the artifact carries no host path and states its limits', () => {
  assert.ok(artifact, 'the measurement artifact is missing');
  const text = JSON.stringify(artifact);
  assert.ok(!text.includes(os.tmpdir()), 'the artifact leaks a host temp path');
  assert.ok(!/\/home\/[a-z]/i.test(text), 'the artifact leaks a host home path');
  assert.ok(Array.isArray(artifact.limits) && artifact.limits.length >= 3, 'the artifact must carry its limits');
  assert.ok(
    artifact.limits.some((l) => /zero external users/i.test(l)),
    'the honest limit about external users must ride with the artifact',
  );
});

test('D5: THIS tree ships a one-pin README (the fix is real, not only named)', () => {
  assert.ok(artifact, 'the measurement artifact is missing');
  assert.ok(artifact.thisTree, 'the artifact does not record what this tree would ship');
  assert.equal(artifact.thisTree.verdict, 'clean', `this tree would ship ${JSON.stringify(artifact.thisTree.pins)}`);

  // The artifact must track the version it was measured against: the moment
  // package.json moves on, a recorded "clean" is history, not a gate.
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    artifact.thisTree.version,
    pkg.version,
    `the artifact measured version ${artifact.thisTree.version} but package.json says ${pkg.version} — re-run tools/measure-shipped-readme-pin.mjs`,
  );
  assert.deepEqual(artifact.thisTree.pins, [`v${pkg.version}`]);
});

test('D6: package.json wires prepublishOnly to the gate — the refusal stands in front of the publish', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const hook = pkg.scripts && pkg.scripts.prepublishOnly;
  assert.ok(hook, 'package.json has no prepublishOnly hook — the publish is still unguarded');
  assert.match(hook, /gate-shipped-readme-pin\.mjs/, 'prepublishOnly must run the shipped-README gate');
});

test('G1: the gate refuses a two-pin README and passes a one-pin one', async () => {
  const { judgeShipped } = await import('../tools/gate-shipped-readme-pin.mjs');
  const two = judgeShipped({ readme: 'npm install github:auroraxo/sememe#v0.4.28\nand github:auroraxo/sememe#v0.4.27\n', version: '0.4.28' });
  assert.equal(two.ok, false, 'a two-pin README must be refused');
  assert.match(two.problems.join(' '), /R1/);

  const one = judgeShipped({ readme: 'npm install github:auroraxo/sememe#v0.4.28\n', version: '0.4.28' });
  assert.equal(one.ok, true, `a one-pin README must pass, got ${JSON.stringify(one.problems)}`);
  assert.deepEqual(one.pins, ['v0.4.28']);

  const wrong = judgeShipped({ readme: 'npm install github:auroraxo/sememe#v0.4.27\n', version: '0.4.28' });
  assert.equal(wrong.ok, false, 'a pin to another version must be refused');
  assert.match(wrong.problems.join(' '), /R2/);
});

test('G2: npm pack does NOT run the gate — the immutable history stays measurable', () => {
  // The channel-parity tool packs every published tag; 0.4.23 and 0.4.28
  // carry two pins forever. A gate that ran on pack would make that history
  // unmeasurable — the gate must fire on PUBLISH only.
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(!pkg.scripts.prepare, 'a `prepare` script would run on npm pack and block the parity measurement');
  assert.ok(!pkg.scripts.prepack, 'a `prepack` script would run on npm pack and block the parity measurement');
});

test('G3: the gate still refuses — it must not have been softened into a warning', () => {
  const source = readFileSync(GATE, 'utf8');
  assert.match(source, /process\.exit\(1\)/, 'the gate must exit non-zero when it refuses');
  assert.ok(!/prepublishOnly.{0,40}warn/i.test(source), 'the gate must not warn instead of refusing');
});
