// The FLAG surface of the PINNED install — measured on the shipped bytes.
//
// WHY THIS FILE EXISTS (measured 2026-11-07, this host)
//
//   The strict flag surface shipped on main (d908b4f, tag v0.4.7). The pin
//   the README names is the only install channel, and the pin is a TAG. But
//   every flag-level test in this repository packs THIS TREE
//   (test/flag-surface.test.mjs) — nothing measured the flags of the bytes a
//   stranger installs. That is the gap the release-surface gate names
//   ("release-surface checks commands and exports, not the flag level"), and
//   it is why the class has repeated six times in this repo (v0.4.1 journey
//   dead-ends, v0.4.3 missing lock, v0.4.4 elided payload, v0.4.5 missing
//   peer refusal, v0.4.6 silent flag typos, v0.4.7 duplicated flag list):
//   every one of those was "fixed on main, the pin still pointed behind".
//
//   Measured on the PUBLISHED v0.4.7 install (a github:-install in an empty
//   app, no clone), this host:
//
//     sememe decode --rpc <dir> <prog> <payload>
//       -> exit 2, "sememe decode: unknown flag \"--rpc\" — this command
//          accepts: --store, --trailing, --absent, --union supported flags:
//          --store, --trailing, --absent, --union"
//          The same four flags printed TWICE in one line.
//     sememe native-provenance --store <dir>
//       -> exit 2, "... this command accepts: (none) supported flags: (none)"
//          An empty list printed twice, as "(none)".
//
//   The fix is on main (33d0ee3, "print the supported flag list once per
//   refusal, not twice") — and the tag the README pins was cut BEFORE it.
//   So the bytes a stranger installs still say it twice.
//
// WHAT THIS TEST PINS
//
//   F1  the pinned tag's refusal prints the supported flag list EXACTLY ONCE
//       (the no-suggestion branch — the one the v0.4.7 message broke).
//   F2  the same for the suggestion branch (the branch v0.4.7 got right —
//       the false-positive guard for this file's own fix).
//   F3  a command that declares NO flags says "accepts no flags" and does
//       not print an empty list twice.
//   F4  the pinned tag refuses the silent-typo class by name, BEFORE any
//       work: exit 2, no lock file written, no default store created. This
//       is the guard that keeps the pin from regressing into the v0.4.6
//       behaviour the README now denies.
//   G1  GUARD: the CURRENT tree's packed tarball behaves the same way. The
//       ladder is read against the fixed world; without this guard, a change
//       that broke the flag surface entirely would satisfy F1-F3 by
//       refusing for the wrong reason.
//
//   The pinned tag comes from the README, exactly like the other journeys
//   (installed-tag-journey, lock-journey, base58-journey, peer-tag-journey):
//   one tag, read from the pin, never a hardcoded version. A tag that is
//   neither local nor fetchable is a NAMED SKIP — never a silent green over
//   a different tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function pinnedTag() {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const m = readme.match(/github:auroraxo\/sememe#(v[\d.]+\.[\d.]+[-\w.]*)/g);
  assert.ok(m && m.length, 'README must pin an install tag');
  const tags = [...new Set(m.map((s) => s.split('#')[1]))];
  assert.equal(tags.length, 1, `README must pin exactly one tag, found ${tags.join(', ')}`);
  return tags[0];
}

class SkipUnmeasurableTag extends Error {}

/**
 * npm pack of a tag worktree + install into an empty app.
 *
 * The app is a real consumer's shape: a directory with node_modules/sememe
 * and nothing else. No clone, no repository — the same bytes a stranger
 * gets from `npm install github:auroraxo/sememe#<tag>`.
 */
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
      work = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-flag-tag-tree-'));
      execFileSync('git', ['worktree', 'add', '--detach', work, tag], { cwd: ROOT, stdio: 'pipe' });
      source = work;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-flag-tag-app-'));
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

/**
 * Run the CLI of an installed app.
 *
 * HOME is redirected into the app so that a command which falls back to the
 * DEFAULT store (~/.sememe) leaves a trace there — the side effect the
 * refusal rule forbids.
 */
function runCli(app, dir, args) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return spawnSync(process.execPath, [path.join(app, 'bin', 'sememe.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
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

test(`F1: the pinned tag (${PIN}) prints the supported flag list EXACTLY ONCE`, { skip: skipReason || false }, () => {
  // "--rpc" is a flag of pull/gap, not of decode, and it is not close enough
  // to any of decode's flags to be suggested — so this is the branch that
  // prints the list on its own.
  const r = runCli(pinnedApp.app, pinnedApp.dir, ['decode', '--rpc', '/tmp/x', 'ABC', '123']);
  assert.equal(r.status, 2, `the refusal must use the usage channel, got ${r.status}: ${r.stdout}${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /unknown flag "--rpc"/, `the refusal must name the flag: ${out.trim()}`);
  const list = '--store, --trailing, --absent, --union';
  const occurrences = out.split(list).length - 1;
  assert.equal(occurrences, 1,
    `the supported flag list must appear exactly once, saw ${occurrences}: ${out.trim()}`);
});

test(`F2: the pinned tag (${PIN}) prints the flag list once in the SUGGESTION branch too`, { skip: skipReason || false }, () => {
  const r = runCli(pinnedApp.app, pinnedApp.dir, ['lock', '--store', '/tmp/x', '--o', 'out.lock']);
  assert.equal(r.status, 2, `the refusal must use the usage channel, got ${r.status}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /did you mean "--out"\?/, `the refusal must name the repair: ${out.trim()}`);
  const list = '--store, --out';
  const occurrences = out.split(list).length - 1;
  assert.equal(occurrences, 1,
    `the supported flag list must appear exactly once, saw ${occurrences}: ${out.trim()}`);
});

test(`F3: the pinned tag (${PIN}) says "accepts no flags" for a command without flags`, { skip: skipReason || false }, () => {
  const r = runCli(pinnedApp.app, pinnedApp.dir, ['native-provenance', '--store', '/tmp/x']);
  assert.equal(r.status, 2, `the refusal must use the usage channel, got ${r.status}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /accepts no flags/, `a command without flags must say so: ${out.trim()}`);
  assert.doesNotMatch(out, /\(none\)/, `an empty list must not be printed as "(none)": ${out.trim()}`);
  assert.doesNotMatch(out, /supported flags:/, `a command without flags has no list to print: ${out.trim()}`);
});

test(`F4: the pinned tag (${PIN}) refuses the silent-typo class BEFORE any work`, { skip: skipReason || false }, () => {
  const r = runCli(pinnedApp.app, pinnedApp.dir, ['lock', '--store', '/tmp/x', '--o', 'out.lock']);
  assert.equal(r.status, 2, `the refusal must use the usage channel, got ${r.status}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /unknown flag "--o"/, `the refusal must name the flag: ${out.trim()}`);
  // no side effect: no lock file written anywhere in the app
  const stray = fs.readdirSync(pinnedApp.dir).filter((f) => f.includes('sememe.lock') || f === 'out.lock');
  assert.deepEqual(stray, [], `a refusal must not write a lock file, found: ${stray.join(', ')}`);
  // no side effect: the DEFAULT store was not created
  const defaultStore = path.join(pinnedApp.dir, 'home', '.sememe');
  assert.ok(!fs.existsSync(defaultStore),
    `a refusal must not create the default store, found: ${defaultStore}`);
});

// G1: the false-positive guard. This is the one test here expected to be
// GREEN while a defective tag may still be pinned: it measures the CURRENT
// tree's packed tarball, the fixed world the F-ladder is read against.
test(`G1 GUARD: the current tree's tarball prints the flag list once and refuses before any work`, () => {
  const app = packAndInstall(null);
  const noSuggestion = runCli(app.app, app.dir, ['decode', '--rpc', '/tmp/x', 'ABC', '123']);
  assert.equal(noSuggestion.status, 2, 'the current tree must refuse an unknown flag');
  const out = noSuggestion.stdout + noSuggestion.stderr;
  const list = '--store, --trailing, --absent, --union';
  assert.equal(out.split(list).length - 1, 1,
    `the current tree must print the flag list once, saw: ${out.trim()}`);
  const noFlags = runCli(app.app, app.dir, ['native-provenance', '--store', '/tmp/x']);
  assert.equal(noFlags.status, 2, 'the current tree must refuse an unknown flag');
  assert.match(noFlags.stdout + noFlags.stderr, /accepts no flags/,
    'the current tree must say a flagless command accepts no flags');
});
