// The acquisition SUBPATHS must refuse in sememe's own voice, not Node's.
//
// MEASURED 2026-11-06, from a BARE INSTALL of the packed tarball (the bytes a
// `github:auroraxo/sememe#vX.Y.Z` install receives), with the peer absent:
//
//   import('sememe/pull')
//     -> ERR_MODULE_NOT_FOUND: Cannot find package '@solana/web3.js' imported
//        from .../node_modules/sememe/src/pull.mjs
//   import('sememe/gap')
//     -> ERR_MODULE_NOT_FOUND: Cannot find package '@solana/web3.js' imported
//        from .../node_modules/sememe/src/acquire.mjs
//
// The CLI already names the repair — `sememe pull` and `sememe gap` refuse with
// "needs @solana/web3.js: install it next to sememe (npm i @solana/web3.js@1.98.4)"
// (bin/sememe.mjs catches the import failure). The LIBRARY surfaces did not:
// the same missing dependency surfaced as a raw Node loader error, with a
// stack trace instead of the install command that fixes it.
//
// This is the defect class the repo has fixed repeatedly and rules in its own
// README ("a refusal is a non-zero exit, not a silent skip"; "the refusal
// names the fix"). A consumer who writes
//
//   import { pull } from 'sememe/pull';
//
// gets a loader stack trace, not a sentence. The README documents
// `sememe/pull` as an export subpath, so this path is a DOCUMENTED surface.
//
// What this test pins:
//
//   L1  importing `sememe/pull` without the peer throws an error whose
//       message names the missing package AND the install command, and does
//       NOT leak the raw Node `ERR_MODULE_NOT_FOUND` code.
//   L2  importing `sememe/gap` without the peer does the same.
//   L3  the refusal still happens — it is a refusal, not a silent success: the
//       module's exports are unreachable and the error is thrown at import.
//   L4  GUARD: with the peer installed, BOTH subpaths import cleanly and
//       expose their documented functions. This is the false-positive guard —
//       it is the one test expected to pass on the pre-fix tree, because the
//       defect is about the ABSENCE of the peer, not about a broken import.
//
// The peer is removed for the test by copying the PACKED TARBALL into a
// temp app and installing it with --omit=peer; the package declares
// @solana/web3.js as an OPTIONAL peer (package.json peerDependenciesMeta), so
// npm never installs it on its own. The test therefore removes it explicitly
// to make the absence deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Pack the tarball and install it into an empty app WITHOUT the peer. */
let NO_PEER = null;
function withoutPeer() {
  if (NO_PEER) return NO_PEER;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-peer-surface-'));
  const out = execFileSync('npm', ['pack', '--silent'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop().trim();
  const tgz = path.join(dir, 'sememe.tgz');
  fs.renameSync(path.join(ROOT, out), tgz);
  execFileSync('npm', ['init', '-y'], { cwd: dir, stdio: 'ignore' });
  // --omit=peer: the peer is OPTIONAL in package.json, so this is the state a
  // decoder-only consumer is in. npm would not install it anyway; the flag
  // makes the intent explicit and survives a peer that IS resolvable.
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--omit=peer', path.basename(tgz)], { cwd: dir, stdio: 'ignore' });
  const app = path.join(dir, 'node_modules', 'sememe');
  // The peer must really be absent, or the test proves nothing.
  assert.ok(!fs.existsSync(path.join(dir, 'node_modules', '@solana', 'web3.js')),
    'the peer must be absent for this test to measure anything');
  NO_PEER = { dir, app };
  return NO_PEER;
}

/** Import one subpath in a child process and report what happened. */
function importSubpath(subpath) {
  const { dir } = withoutPeer();
  const script = `
    try {
      const m = await import(${JSON.stringify(subpath)});
      console.log(JSON.stringify({ imported: true, exports: Object.keys(m).sort() }));
    } catch (error) {
      console.log(JSON.stringify({
        imported: false,
        code: error?.code ?? null,
        name: error?.name ?? null,
        message: String(error?.message ?? error),
      }));
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, `the probe process must not crash: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

test('L1 importing sememe/pull without the peer names the package and the install command', () => {
  const r = importSubpath('sememe/pull');
  assert.equal(r.imported, false, 'the import must be refused, not silently succeed');
  assert.match(r.message, /@solana\/web3\.js/, 'the refusal must name the missing package');
  assert.match(r.message, /npm i @solana\/web3\.js/, 'the refusal must name the install command that fixes it');
});

test('L2 importing sememe/gap without the peer names the package and the install command', () => {
  const r = importSubpath('sememe/gap');
  assert.equal(r.imported, false, 'the import must be refused, not silently succeed');
  assert.match(r.message, /@solana\/web3\.js/, 'the refusal must name the missing package');
  assert.match(r.message, /npm i @solana\/web3\.js/, 'the refusal must name the install command that fixes it');
});

test('L3 the refusal is sememe\'s own, not a raw Node loader error', () => {
  for (const subpath of ['sememe/pull', 'sememe/gap']) {
    const r = importSubpath(subpath);
    assert.notEqual(r.code, 'ERR_MODULE_NOT_FOUND',
      `${subpath} must not leak the raw Node module-resolution error (got ${r.code}: ${r.message.slice(0, 120)})`);
    assert.notEqual(r.name, 'Error',
      `${subpath} must refuse with a named, product-level error, not a bare Error`);
  }
});

test('L4 GUARD with the peer installed, both subpaths import and expose their documented functions', () => {
  // The false-positive guard: this passes on the pre-fix tree too, because the
  // defect is about the ABSENCE of the peer. It exists so a fix that simply
  // broke the acquisition surface would be caught.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-peer-guard-'));
  const out = execFileSync('npm', ['pack', '--silent'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop().trim();
  const tgz = path.join(dir, 'sememe.tgz');
  fs.renameSync(path.join(ROOT, out), tgz);
  execFileSync('npm', ['init', '-y'], { cwd: dir, stdio: 'ignore' });
  execFileSync('npm', ['install', '--no-audit', '--no-fund', path.basename(tgz)], { cwd: dir, stdio: 'ignore' });
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '@solana/web3.js@1.98.4'], { cwd: dir, stdio: 'ignore' });

  const script = `
    const pull = await import('sememe/pull');
    const gap = await import('sememe/gap');
    console.log(JSON.stringify({
      pull: typeof pull.pull,
      gap: typeof gap.probeGap,
      gapNext: typeof gap.nextStep,
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, `both subpaths must import with the peer: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(parsed.pull, 'function', 'sememe/pull must expose pull()');
  assert.equal(parsed.gap, 'function', 'sememe/gap must expose probeGap()');
  assert.equal(parsed.gapNext, 'function', 'sememe/gap must expose nextStep()');
});

test('L5 the CLI refusal says the install instruction ONCE, not twice', () => {
  // Measured 2026-11-06, my own defect: the library started refusing with a
  // complete sentence ("the acquisition path needs @solana/web3.js: install it
  // next to sememe (...)") while bin/sememe.mjs still wrapped that refusal in
  // its own sentence — so `sememe pull` printed "install it next to sememe"
  // TWICE. The CLI must now pass the library's refusal through unchanged,
  // because the library's sentence is the complete one.
  const { dir } = withoutPeer();
  for (const command of ['pull', 'gap']) {
    const result = spawnSync(process.execPath, [
      path.join(dir, 'node_modules', 'sememe', 'bin', 'sememe.mjs'), command,
      '11111111111111111111111111111111',
    ], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${command} must refuse without the peer`);
    const out = result.stdout + result.stderr;
    const occurrences = out.split('install it next to sememe').length - 1;
    assert.equal(occurrences, 1,
      `${command} must name the install instruction exactly once, saw ${occurrences}: ${out.trim()}`);
    assert.match(out, /@solana\/web3\.js/, `${command} must name the missing package`);
    assert.match(out, /npm i @solana\/web3\.js/, `${command} must name the install command`);
  }
});

