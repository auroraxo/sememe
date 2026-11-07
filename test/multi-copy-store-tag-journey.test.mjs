// The multi-copy-store journey, on the bytes a stranger installs.
//
// WHY THIS IS A SEPARATE FILE from test/multi-copy-store.test.mjs: that file
// pins the BEHAVIOUR of the fix against this tree. This file pins that the
// TAG a stranger installs carries the fix — a fix that is on main but not in
// the tag is exactly how v0.4.8 shipped the defect in the first place
// (measured 2026-11-07 on the published v0.4.8 install: one store, two
// verdicts, and a green CI gate over a damaged second copy).
//
// The tag comes from README.md — the same pin the front page hands out. It is
// never hardcoded here: a script that keeps measuring v0.4.8 while the README
// pins v0.4.9 measures a tag nobody installs.
//
// It packs the pinned tag the way test/flag-tag-journey.test.mjs does (npm
// pack of an exported tag worktree = the bytes a `github:#<tag>` install
// receives), installs it into an empty app, and runs the SAME measurement the
// tool runs (tools/measure-multi-copy-store.mjs --bin <installed bin>), so
// the journey and the committed artifact cannot drift apart.
//
// If the tag is neither local nor fetchable, the tests SKIP with that reason
// — a named skip, never a silent green over a different tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-multi-copy-store.mjs');

function pinnedTag() {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const m = readme.match(/github:auroraxo\/sememe#(v[\d.]+\.[\d.]+[-\w.]*)/g);
  assert.ok(m && m.length, 'README must pin an install tag');
  const tags = [...new Set(m.map((s) => s.split('#')[1]))];
  assert.equal(tags.length, 1, `README must pin exactly one tag, found ${tags.join(', ')}`);
  return tags[0];
}

class SkipUnmeasurableTag extends Error {}

/** npm pack of a tag worktree + install into an empty app — the bytes a
 *  `github:#<tag>` install receives. No clone, no repository. */
function packAndInstall(tag) {
  let work = null;
  try {
    let source = ROOT;
    if (tag) {
      const probe = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], { cwd: ROOT });
      if (probe.status !== 0) {
        const fetched = spawnSync('git', ['fetch', '--depth', '1', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], {
          cwd: ROOT, encoding: 'utf8',
        });
        if (fetched.status !== 0) {
          const why = String(fetched.stderr || '').trim().split('\n')[0];
          throw new SkipUnmeasurableTag(`pinned tag ${tag} is not local and not fetchable from origin: ${why}`);
        }
      }
      work = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-multicopy-tag-tree-'));
      execFileSync('git', ['worktree', 'add', '--detach', work, tag], { cwd: ROOT, stdio: 'pipe' });
      source = work;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-multicopy-tag-app-'));
    // --pack-destination: pack into THIS test's own directory, never into the
    // shared source tree — concurrent packs renamed each other's tarball away
    // (ENOENT, measured 2026-11-07).
    const out = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: source, encoding: 'utf8' })
      .trim().split('\n').pop().trim();
    const tgz = path.join(dir, 'sememe.tgz');
    fs.renameSync(path.join(dir, out), tgz);
    execFileSync('npm', ['init', '-y'], { cwd: dir, stdio: 'ignore' });
    execFileSync('npm', ['install', '--no-audit', '--no-fund', path.basename(tgz)], { cwd: dir, stdio: 'ignore' });
    return { dir, app: path.join(dir, 'node_modules', 'sememe') };
  } finally {
    if (work) {
      try { execFileSync('git', ['worktree', 'remove', '--force', work], { cwd: ROOT, stdio: 'pipe' }); }
      catch { /* best effort: the suite must not fail on a stale worktree */ }
    }
  }
}

/** Run the measurement tool against a binary. The tool exits 1 when the
 * contract is violated — that is the MEASUREMENT, not a test failure, so the
 * exit code is captured, not thrown. */
function measure(bin, tag) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-mcs-journey-')), 'report.json');
  const r = spawnSync(process.execPath, [TOOL, '--bin', bin, '--tag', tag, '--out', out], {
    cwd: ROOT, encoding: 'utf8', timeout: 180_000,
  });
  const report = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  return { exit: r.status, report, stderr: r.stderr };
}

const PIN = pinnedTag();

let pinnedApp = null;
let skipReason = null;
try {
  pinnedApp = packAndInstall(PIN);
} catch (err) {
  if (!(err instanceof SkipUnmeasurableTag)) throw err;
  skipReason = err.message;
}

test(`M1: the pinned tag (${PIN}) answers one store with ONE answer`, { skip: skipReason || false }, () => {
  const r = measure(path.join(pinnedApp.app, 'bin', 'sememe.mjs'), PIN);
  assert.ok(r.report, `the measurement must produce a report: ${r.stderr}`);
  const s1 = r.report.twoCopies.s1;
  assert.equal(s1.plainExit, 0, 'plain decode must answer');
  assert.equal(s1.unionExit, 0,
    `the union path must not refuse bytes the plain path decodes (v0.4.8 refused them)`);
  assert.equal(s1.sameFingerprint, true,
    'one store, one answer — whichever flag the caller passes');
  assert.equal(s1.plainInstruction, 'sell_v3');
  assert.equal(s1.unionInstruction, 'sell_v3');
});

test(`M2: the pinned tag (${PIN}) refuses to lock a store whose second copy is damaged`, { skip: skipReason || false }, () => {
  const r = measure(path.join(pinnedApp.app, 'bin', 'sememe.mjs'), PIN);
  const s2 = r.report.twoCopies.s2;
  assert.equal(s2.lockExit, 1, 'the lock must refuse a damaged store');
  assert.equal(s2.lockFileWritten, false, 'no lock file may exist over damage');
});

test(`M3: the pinned tag (${PIN}) names the damaged copy at verify time`, { skip: skipReason || false }, () => {
  const r = measure(path.join(pinnedApp.app, 'bin', 'sememe.mjs'), PIN);
  const s3 = r.report.twoCopies.s3;
  assert.equal(s3.verifyErrorExit, 1, 'the CI gate must fail over damage');
  assert.ok(s3.violations >= 1, 'the damage is a violation, not a note');
  assert.equal(s3.unverified.length, 1, 'the damaged copy must be named');
  assert.ok(s3.unverified[0].receipt.includes(s3.damagedCopy.replace(/^sha256:/, '')));
});

test(`M4 (CONTROL): the pinned tag (${PIN}) keeps a single-copy store green`, { skip: skipReason || false }, () => {
  const r = measure(path.join(pinnedApp.app, 'bin', 'sememe.mjs'), PIN);
  const s4 = r.report.controlSingleCopy;
  assert.equal(s4.plainExit, 0);
  assert.equal(s4.unionExit, 0);
  assert.equal(s4.sameFingerprint, true);
  assert.equal(s4.verdict, 'single_source');
  assert.equal(s4.adoptedOnly, true);
  assert.equal(s4.lockExit, 0);
  assert.equal(s4.verifyExit, 0, 'the fix must not turn a clean store red');
});

// G1: the false-positive guard. This is the test expected to be GREEN while
// a defective tag may still be pinned: it measures the CURRENT tree, the
// fixed world the M-ladder is read against.
test('G1 GUARD: the current tree satisfies the whole multi-copy contract', () => {
  const r = measure(path.join(ROOT, 'bin', 'sememe.mjs'), 'current-tree');
  assert.equal(r.exit, 0,
    `the current tree must satisfy the contract: ${JSON.stringify(r.report?.verdict?.violations)}`);
  assert.equal(r.report.verdict.ok, true);
});
