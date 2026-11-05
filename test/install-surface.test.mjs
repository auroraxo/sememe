// The install surface is a CONTRACT, not decoration: `npm install
// github:auroraxo/sememe#vX.Y.Z` puts a README in node_modules whose
// instructions a consumer can only follow with the files that tarball ships.
//
// MEASURED 2026-11-05 (pre-fix tree 222f25b), from a real tarball install
// (`npm pack` -> `npm install ./sememe-0.4.1.tgz` in an empty dir, no clone):
//   D1  the install section's decode example needs `./store`, but the install
//       section never says how a store comes to exist. The consumer's first
//       decode dies with `no sememe store at ./store: run "sememe pull" first`
//       — and `sememe pull` is not a command their shell can run.
//   D2  bare `sememe` is not on PATH after a plain `npm install` (no global
//       install, no npx mentioned anywhere in the README). `node bin/sememe.mjs`
//       (the README's other documented form) resolves only inside a clone.
//       The one invocation that works in BOTH a clone and a bare consumer app
//       — `npx sememe` (npm exec resolves the root package's own bin) — is
//       documented nowhere.
//   D3  the "why we do not publish" paragraph justifies the git-tag-only
//       channel with "tests, fixtures and qualification harness must not ship"
//       — but the files allowlist ALREADY ships none of those (55 files:
//       src/, interface/, vendor/, bin/, index.mjs, LICENSE, README.md only),
//       pinned by test/package.test.mjs 'the package does not ship the
//       qualification harness'. As written it states a reason that the
//       package contract contradicts.
//
// Everything here runs from the PACKED TARBALL (`npm pack` of this tree), the
// same bytes a `github:`-tag install receives — so the test cannot pass while
// the README promises paths the install does not carry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ---- build the tarball the way a consumer receives it (once, cached) ----
let PACK = null;
function tarball() {
  if (PACK) return PACK;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-install-surface-'));
  const out = execFileSync('npm', ['pack', '--silent'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop().trim();
  const tgz = path.join(dir, 'sememe.tgz');
  fs.renameSync(path.join(ROOT, out), tgz);
  execFileSync('npm', ['init', '-y'], { cwd: dir, stdio: 'ignore' });
  execFileSync('npm', ['install', '--no-audit', '--no-fund', path.basename(tgz)], { cwd: dir, stdio: 'ignore' });
  const app = path.join(dir, 'node_modules', 'sememe');
  for (const p of ['README.md', 'package.json']) {
    assert.ok(fs.existsSync(path.join(app, p)), `install must carry ${p}`);
  }
  PACK = { dir, app, readme: fs.readFileSync(path.join(app, 'README.md'), 'utf8'), tgz };
  return PACK;
}

function runInApp(cmdAndArgs) {
  return execFileSync('bash', ['-c', cmdAndArgs], { cwd: tarball().dir, encoding: 'utf8' });
}

test('T1 the packed tarball still ships exactly the product, never the harness', () => {
  const { app } = tarball();
  for (const p of ['src', 'interface', 'vendor', 'bin', 'index.mjs']) {
    assert.ok(fs.existsSync(path.join(app, p)), `the product path ${p} must ship`);
  }
  for (const p of ['tools', 'test', 'research']) {
    assert.ok(!fs.existsSync(path.join(app, p)), `the harness path ${p} must NOT ship`);
  }
});

test('T2 the shipped README documents the store path a consumer can actually run', () => {
  const { readme } = tarball();
  const install = readme.slice(readme.indexOf('## Install'));
  // The install section must show acquisition from the consumer cwd in a form
  // that works there: `npx sememe pull ...` (npm exec resolves the package's
  // own bin), not the clone-only `node bin/sememe.mjs`.
  assert.match(install, /npx sememe pull [^\n]*--store/,
    'the install section must show an npx-form pull that works from a consumer cwd');
  assert.match(install, /npx sememe decode [^\n]*--store/,
    'the install section must show an npx-form decode that works from a consumer cwd');
});

test('T3 the store-refusal hint names a command reachable through the documented install', () => {
  const { readme } = tarball();
  // src/store-read.mjs throws `... run "sememe pull" first`; the hint is only
  // honest if the README documents a way to run `sememe` from an install.
  assert.match(readme, /npx sememe/,
    'the README must document `npx sememe` as the invocation form that works from an install');
});

test('T4 the why-not-published paragraph states a reason the package contract supports', () => {
  const { readme } = tarball();
  const para = readme.split('\n').find((l) => l.includes('Publishing to the npm registry'));
  assert.ok(para, 'the why-not-published paragraph must exist');
  assert.match(para, /files allowlist already ships none of this repository[^\n]*tests/i,
    'the paragraph must state the measured reason (the files allowlist already ships no harness), '
    + 'not the contradicted one (tests/fixtures/harness must not ship)');
});

test('T5 GUARD the npx-form commands must work from the bare install, verbatim', () => {
  const { readme, dir } = tarball();
  // Extract the npx commands the install section documents and check that the
  // ones the consumer journey needs are there.
  const install = readme.slice(readme.indexOf('## Install'));
  const cmds = [...install.matchAll(/^\s*npx sememe ([a-z][a-z0-9-]*)/gm)].map((m) => m[1]);
  assert.ok(cmds.length >= 2, `the install section must document npx commands, found: ${cmds.join(',')}`);
  const uniq = [...new Set(cmds)];
  for (const c of ['pull', 'decode']) {
    assert.ok(uniq.includes(c), `npx sememe ${c} must be documented`);
  }
  // The documented form must really run from the bare install. `pull` and
  // `decode` have no --help flag (they refuse with a named error instead), so
  // the check is that each refuses for the RIGHT reason: the command exists
  // and its argument check fired — not "command not found".
  const pullErr = spawnSync('npx', ['--no-install', 'sememe', 'pull'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(pullErr.status, 127, 'npx sememe pull must not be "command not found"');
  assert.match(pullErr.stderr + pullErr.stdout, /program/i,
    'npx sememe pull must reach the command and refuse on its argument, not on lookup');
  const decodeErr = spawnSync('npx', ['--no-install', 'sememe', 'decode'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(decodeErr.status, 127, 'npx sememe decode must not be "command not found"');
  assert.match(decodeErr.stderr + decodeErr.stdout, /program id/i,
    'npx sememe decode must reach the command and refuse on its argument, not on lookup');
  // The offline vendored decode must really produce a named decode.
  const out = execFileSync('npx', ['--no-install', 'sememe', 'decode-native',
    '11111111111111111111111111111111',
    '0200000040420f00000000000000000000000000000000000000000000000000000000000000000000000000'],
    { cwd: dir, encoding: 'utf8' });
  assert.match(out, /"name":\s*"Transfer"/, 'the documented form must really decode');
});

test('T6 GUARD a hand-edit that drops npx from the install section goes red', () => {
  const { readme } = tarball();
  const tampered = readme.replace(/npx sememe pull/g, 'node bin/sememe.mjs pull');
  const install = tampered.slice(tampered.indexOf('## Install'));
  assert.doesNotMatch(install, /npx sememe pull[^\n]*--store/,
    'mutation must be caught: npx-form pull gone');
});
