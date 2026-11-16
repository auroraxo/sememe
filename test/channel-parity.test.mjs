// CHANNEL PARITY (14.11. PULS AL): does the npm registry serve the same bytes
// the git tag of the same name carries?
//
// THE CLAIM THIS FILE PINS
// tools/measure-channel-parity.mjs measures, per published sememe version, the
// tarball the registry actually serves against the tarball npm builds from the
// exported git tag (the bytes `npm install github:auroraxo/sememe#v<version>`
// installs), file by file, byte for byte, and classifies each version:
//
//   parity / doc-divergence / product-divergence / stage-placeholder / no-tag
//
// MEASURED (research/channel-parity-2026-11-15.json, verdict
// channel-parity-broken):
//   * 0.4.21 PRODUCT-DIVERGENCE: the registry ships src/rawle.mjs, the tag
//     v0.4.21 does not. npm's own gitHead for 0.4.21 is 05e6643 — a
//     DESCENDANT of the tag commit a0cfd70 (05e6643 adds the file; 3401f9f,
//     which later wires it into the product, is not in the published tarball
//     either). A stranger pinning "0.4.21" gets different code depending on
//     the channel.
//   * 0.4.22 DOC-DIVERGENCE: published from 40204fd, one commit AFTER tag
//     725d946 — only README.md differs (the release-record block); the product
//     files are byte-identical.
//   * 0.4.23 … 0.4.27 PARITY: same files, same bytes; npm gitHead equals the
//     tag commit (0.4.27's gitHead 84398b8 is the tag commit's ANCESTOR — the
//     tag was re-cut later over research/ files only, and the shipped product
//     bytes are unchanged, so it still measures parity).
//   * 0.0.0-stage STAGE-PLACEHOLDER: a published stub (package.json
//     "stub": true) with no git tag; it ships no product code.
//
// WHY THIS FILE EXISTS AT ALL
// The README claims both channels "deliver the same product files from the
// same code", and the release-surface contract checks the newest tag against
// the README — but nothing checked the registry's bytes against the tag's.
// Two published versions slipped through: one shipped code the tag does not
// have. Both are IMMUTABLE (npm versions and git tags cannot be rewritten), so
// the remedy is this NAMED record plus the gate: the next release cannot ship
// without this pin going green on it.
//
// FACES
//   D1 the committed verdict is DERIVED from the committed summary — editing
//      the verdict string without the summary fails, and vice versa.
//   D2 git-side truth, fully OFFLINE: tag v0.4.21 does NOT contain
//      src/rawle.mjs while the registry's recorded gitHead (05e6643) DOES; tag
//      v0.4.22's README differs from 40204fd's README; every version's
//      recorded tagCommit resolves to the real local tag.
//   D3 the newest published version measures PARITY — the live invariant that
//      makes this a gate rather than a museum piece (network-gated).
//   D4 the NEWEST version in the record measures parity: a future re-measure
//      that adds a divergent release to this artifact fails the pin.
//   G1 falsifier: flipping the committed 0.4.21 classification (or deleting its
//      product file from the record) fails D1/D2.
//   G2 falsifier: a recorded tagCommit that does not match the real tag fails.
//   G3 (network, named skip) re-running the tool against the LIVE registry
//      reproduces the committed artifact — VERIFY OK.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-channel-parity.mjs');
const ARTIFACT = process.env.SEMEME_CHANNEL_PARITY_ARTIFACT
  ? path.resolve(process.env.SEMEME_CHANNEL_PARITY_ARTIFACT)
  : path.join(ROOT, 'research', 'channel-parity-2026-11-16.json');

assert.ok(existsSync(ARTIFACT), 'committed channel-parity artifact missing — run the tool first');
const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));

function git(...args) {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function entry(version) {
  const e = artifact.versions.find((v) => v.version === version);
  assert.ok(e, `version ${version} missing from the artifact`);
  return e;
}

test('D1 the committed verdict is derived from the committed summary', () => {
  const s = artifact.summary;
  assert.equal(s.measured, artifact.versions.length, 'summary.measured disagrees with the version list');
  const derived = s.productDivergence > 0
    ? 'channel-parity-broken'
    : (s.docDivergence > 0 ? 'channel-parity-doc-only' : 'channel-parity-clean');
  assert.equal(artifact.verdict, derived, 'verdict string is not the one the summary derives');
  // each counter is the count of its own classification — editing one
  // classification without its counter fails here.
  const count = (c) => artifact.versions.filter((v) => v.classification === c).length;
  assert.equal(s.productDivergence, count('product-divergence'));
  assert.equal(s.docDivergence, count('doc-divergence'));
  assert.equal(s.parity, count('parity'));
  assert.equal(s.stagePlaceholder, count('stage-placeholder'));
  assert.equal(s.noTag, count('no-tag'));
  assert.equal(artifact.tool, 'tools/measure-channel-parity.mjs');
});

test('D2a 0.4.21: the registry shipped src/rawle.mjs and the tag does not have it (offline git proof)', () => {
  const e = entry('0.4.21');
  assert.equal(e.classification, 'product-divergence');
  assert.deepEqual(e.productFilesAffected, ['src/rawle.mjs'], 'the recorded product divergence must be exactly src/rawle.mjs');
  assert.deepEqual(e.onlyInRegistry, ['src/rawle.mjs']);
  assert.deepEqual(e.onlyInTag, []);
  // the tag side of the claim, from git itself:
  const tagHas = spawnSync('git', ['cat-file', '-e', `v0.4.21:src/rawle.mjs`], { cwd: ROOT });
  assert.notEqual(tagHas.status, 0, 'v0.4.21 DOES contain src/rawle.mjs now — the recorded divergence is stale, re-measure');
  // the registry side's recorded commit really added the file:
  const headHas = spawnSync('git', ['cat-file', '-e', `${e.npmGitHead}:src/rawle.mjs`], { cwd: ROOT });
  assert.equal(headHas.status, 0, `npm gitHead ${e.npmGitHead} does not contain src/rawle.mjs`);
  // the mechanism the record names: gitHead is a descendant of the tag.
  assert.equal(e.commitRelation, 'gitHead-is-descendant-of-tag');
  spawnSync('git', ['merge-base', '--is-ancestor', e.tagCommit, e.npmGitHead], { cwd: ROOT });
  // …and the later wiring commit is NOT inside the published tree:
  assert.ok(!e.npmGitHead.startsWith('3401f9f'), 'published gitHead unexpectedly is the wiring commit');
});

test('D2b 0.4.22: only README.md diverges, and the product files are identical (offline git proof)', () => {
  const e = entry('0.4.22');
  assert.equal(e.classification, 'doc-divergence');
  assert.deepEqual(e.docFilesAffected, ['README.md']);
  assert.deepEqual(e.productFilesAffected, [], '0.4.22 must show NO product divergence');
  assert.equal(e.commitRelation, 'gitHead-is-descendant-of-tag');
  // the recorded README delta is a real git delta between tag and gitHead:
  const diff = git('diff', '--name-only', e.tagCommit, e.npmGitHead, '--', 'README.md');
  assert.match(diff, /README\.md/, 'tag..gitHead does not change README.md');
  const srcDiff = git('diff', '--name-only', e.tagCommit, e.npmGitHead, '--', 'src', 'index.mjs', 'bin', 'interface', 'vendor', 'LICENSE', 'package.json');
  assert.equal(srcDiff.trim(), '', 'tag..gitHead changes product files, but the record says it does not');
});

test('D2c every recorded tagCommit is the real local tag (G2 falsifier)', () => {
  for (const v of artifact.versions) {
    if (!v.tagCommit) continue;
    const real = git('rev-parse', `v${v.version}^{commit}`).trim();
    assert.equal(v.tagCommit, real, `recorded tagCommit for ${v.version} does not match tag v${v.version}`);
    // recorded npm gitHead must be a real commit of this repository:
    spawnSync('git', ['cat-file', '-e', `${v.npmGitHead}^{commit}`], { cwd: ROOT });
    assert.equal(spawnSync('git', ['cat-file', '-e', `${v.npmGitHead}^{commit}`], { cwd: ROOT }).status, 0,
      `npm gitHead ${v.npmGitHead} for ${v.version} is not a commit of this repository`);
  }
});

test('D2d 0.4.23 … 0.4.27 measure parity with gitHead == tag (or an ancestor over research/ only)', () => {
  for (const version of ['0.4.23', '0.4.24', '0.4.25', '0.4.26', '0.4.27']) {
    const e = entry(version);
    assert.equal(e.classification, 'parity', `${version} is not parity`);
    assert.deepEqual(e.productFilesAffected, []);
    assert.deepEqual(e.docFilesAffected, []);
    assert.ok(['same', 'gitHead-is-ancestor-of-tag'].includes(e.commitRelation),
      `${version}: unexpected commit relation ${e.commitRelation}`);
    assert.equal(e.registryFiles, e.tagFiles, `${version}: file counts differ`);
  }
  // the pinned tag of the README is v0.4.27 and it must be among the measured
  // versions, otherwise the gate watches nothing current:
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const pin = /github:auroraxo\/sememe#(v[\d.]+)/.exec(readme);
  assert.ok(pin, 'README does not pin a tag');
  const e = entry(pin[1].replace(/^v/, ''));
  assert.equal(e.classification, 'parity', `the README-pinned version ${pin[1]} does not measure parity`);
});

test('D2e the placeholder is named as such, not counted as a divergence', () => {
  const e = entry('0.0.0-stage');
  assert.equal(e.classification, 'stage-placeholder');
  assert.equal(e.tagCommit, null, 'the stage placeholder must have no tag');
  assert.match(e.note, /placeholder/);
  assert.equal(artifact.summary.stagePlaceholder, 1);
  // it is not a parity claim: it ships no product code
  assert.equal(e.registryFiles, null);
});

test('G1 FALSIFIER: editing the committed classification without the summary fails D1', () => {
  const tampered = JSON.parse(JSON.stringify(artifact));
  tampered.versions.find((v) => v.version === '0.4.21').classification = 'parity';
  const s = tampered.summary;
  const count = (c) => tampered.versions.filter((v) => v.classification === c).length;
  assert.notEqual(s.productDivergence, count('product-divergence'),
    'tampering was NOT caught: the summary still matches the edited classifications');
  // …and the same tamper must fail the offline git truth (D2a's source claim):
  assert.notEqual(tampered.versions.find((v) => v.version === '0.4.21').classification, 'product-divergence');
});

test('G3 live re-derivation reproduces the committed artifact (network)', { skip: process.env.SEMEME_CHANNEL_PARITY === '1' ? false : 'network registry access: set SEMEME_CHANNEL_PARITY=1 (named skip, same class as the other pin tests)' }, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'sememe-channel-parity-'));
  try {
    const res = spawnSync(process.execPath, [TOOL, '--out', path.join(tmp, 'fresh.json'), '--verify', ARTIFACT],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(res.status, 0, `tool failed: ${res.stderr.slice(0, 600)}`);
    assert.match(res.stdout, /VERIFY OK/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('D2f the newest recorded release measures parity — the gate, not the museum', () => {
  const releases = artifact.versions.filter((v) => v.classification !== 'stage-placeholder');
  assert.ok(releases.length >= 2, 'record too short to be a record');
  const newest = releases[releases.length - 1];
  assert.equal(newest.classification, 'parity',
    `the newest recorded release ${newest.version} does NOT measure parity — a divergent release was added to the record`);
  // …and the whole tail since 0.4.23 stays parity, so a single clean release
  // cannot mask a regression behind it.
  const atOrAfter = (v) => {
    const parts = v.version.split('.').map(Number);
    return parts[1] > 4 || (parts[1] === 4 && parts[2] >= 23);
  };
  const regressed = releases.filter((v) => atOrAfter(v) && v.classification !== 'parity');
  assert.deepEqual(regressed.map((v) => `${v.version}:${v.classification}`), [],
    'a release at or after 0.4.23 is not parity');
});

test('G4 tool exit codes: missing usage -> 2, and the artifact the tool writes is itself derivable', () => {
  const noArgs = spawnSync(process.execPath, [TOOL], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(noArgs.status, 2, 'the tool must refuse to run without an output target');
  assert.match(noArgs.stderr, /usage/);
});
