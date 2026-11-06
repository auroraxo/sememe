// The peer refusal is a PROMISE TO THE INSTALL, so it has to be measured on
// the install — the packed tarball of the PINNED TAG, not this working tree.
//
// WHY THIS FILE EXISTS (measured 2026-11-06, this host)
//
//   main's README says: importing `sememe/pull` or `sememe/gap` without the
//   optional peer throws `PeerDependencyMissingError` (code
//   `peer_dependency_missing`) naming the install command — not Node's raw
//   `ERR_MODULE_NOT_FOUND` stack trace. The front page pins
//   `npm install github:auroraxo/sememe#v0.4.5`.
//
//   Measured from THAT install, peer absent (the state the optional peer
//   declaration puts a decoder-only consumer in):
//
//     import('sememe/pull')
//       -> code ERR_MODULE_NOT_FOUND, name "Error",
//          "Cannot find package '@solana/web3.js' imported from
//           .../node_modules/sememe/src/pull.mjs"
//
//   The fix (src/peer.mjs) is on main and test/acquisition-peer-surface.test.mjs
//   pins it — but that test packs THIS tree. The pinned tag was cut BEFORE the
//   fix, so the bytes a stranger installs still leak the raw loader error while
//   the README they read describes the fixed behaviour. Same class as the
//   lock (v0.4.3) and the base58 walkthrough (v0.4.4): main fixed, the pin
//   points at a tag behind it, and only a TAG measurement can see that.
//
// WHAT THIS TEST PINS
//
//   P1  `import('sememe/pull')` from the pinned tag's install, without the
//       peer, refuses in sememe's voice: names the package AND the install
//       command, and does NOT carry Node's ERR_MODULE_NOT_FOUND code.
//   P2  the same for `sememe/gap`.
//   P3  the pinned tag's CLI refuses with the instruction exactly ONCE — the
//       wrap-once rule (L5 in the working-tree file) has to hold on the
//       shipped bytes too.
//   G1  GUARD (expected GREEN on the pre-fix tag): the CURRENT tree's packed
//       tarball refuses in sememe's voice. Without it, a fix that only broke
//       the acquisition surface entirely would satisfy P1-P3 by refusing for
//       the wrong reason; this guard pins that the working tree is the fixed
//       world the ladder is measured against.
//
// The pinned tag comes from the README, exactly like the other journeys
// (installed-tag-journey, lock-journey, base58-journey): one tag, read from
// the pin, never a hardcoded version. A tag that is neither local nor
// fetchable is a NAMED SKIP — never a silent green over a different tree.
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

/** npm pack of a worktree + install into an empty app WITHOUT the peer. */
function packAndInstall({ tag, omitPeer }) {
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
      work = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-peer-tag-'));
      execFileSync('git', ['worktree', 'add', '--detach', work, tag], { cwd: ROOT, stdio: 'pipe' });
      source = work;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-peer-app-'));
    const out = execFileSync('npm', ['pack', '--silent'], { cwd: source, encoding: 'utf8' })
      .trim().split('\n').pop().trim();
    const tgz = path.join(dir, 'sememe.tgz');
    fs.renameSync(path.join(source, out), tgz);
    execFileSync('npm', ['init', '-y'], { cwd: dir, stdio: 'ignore' });
    execFileSync('npm', ['install', '--no-audit', '--no-fund',
      ...(omitPeer ? ['--omit=peer'] : []), path.basename(tgz)], { cwd: dir, stdio: 'ignore' });
    if (omitPeer) {
      // The peer must really be absent, or the refusal is unmeasurable.
      assert.ok(!fs.existsSync(path.join(dir, 'node_modules', '@solana', 'web3.js')),
        'the peer must be absent for the refusal to mean anything');
    }
    return { dir, app: path.join(dir, 'node_modules', 'sememe') };
  } finally {
    if (work) {
      try { execFileSync('git', ['worktree', 'remove', '--force', work], { cwd: ROOT, stdio: 'pipe' }); }
      catch { /* best effort: the suite must not fail on a stale worktree */ }
    }
  }
}

/** Import one subpath in the given app dir and report what happened. */
function importSubpath(dir, subpath) {
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

const PIN = pinnedTag();

let pinnedApp = null;
let skipReason = null;
try {
  pinnedApp = packAndInstall({ tag: PIN, omitPeer: true });
} catch (err) {
  if (!(err instanceof SkipUnmeasurableTag)) throw err;
  skipReason = err.message;
}

test(`P1: the pinned tag (${PIN}) install refuses sememe/pull in sememe's voice, not Node's`, { skip: skipReason || false }, () => {
  const r = importSubpath(pinnedApp.dir, 'sememe/pull');
  assert.equal(r.imported, false, 'the import must be refused, not silently succeed');
  assert.match(r.message, /@solana\/web3\.js/, 'the refusal must name the missing package');
  assert.match(r.message, /npm i @solana\/web3\.js/, 'the refusal must name the install command that fixes it');
  assert.notEqual(r.code, 'ERR_MODULE_NOT_FOUND',
    `the pinned install must not leak the raw Node loader error (got ${r.code}: ${r.message.slice(0, 160)})`);
  assert.notEqual(r.name, 'Error', 'the refusal must be a named, product-level error');
});

test(`P2: the pinned tag (${PIN}) install refuses sememe/gap in sememe's voice, not Node's`, { skip: skipReason || false }, () => {
  const r = importSubpath(pinnedApp.dir, 'sememe/gap');
  assert.equal(r.imported, false, 'the import must be refused, not silently succeed');
  assert.match(r.message, /@solana\/web3\.js/, 'the refusal must name the missing package');
  assert.match(r.message, /npm i @solana\/web3\.js/, 'the refusal must name the install command that fixes it');
  assert.notEqual(r.code, 'ERR_MODULE_NOT_FOUND',
    `the pinned install must not leak the raw Node loader error (got ${r.code}: ${r.message.slice(0, 160)})`);
  assert.notEqual(r.name, 'Error', 'the refusal must be a named, product-level error');
});

test(`P3: the pinned tag (${PIN}) CLI names the install instruction exactly once`, { skip: skipReason || false }, () => {
  for (const command of ['pull', 'gap']) {
    const result = spawnSync(process.execPath, [
      path.join(pinnedApp.app, 'bin', 'sememe.mjs'), command,
      '11111111111111111111111111111111',
    ], { cwd: pinnedApp.dir, encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${command} must refuse without the peer`);
    const out = result.stdout + result.stderr;
    const occurrences = out.split('install it next to sememe').length - 1;
    assert.equal(occurrences, 1,
      `${command} must name the install instruction exactly once, saw ${occurrences}: ${out.trim()}`);
    assert.match(out, /npm i @solana\/web3\.js/, `${command} must name the install command`);
  }
});

// G1: the false-positive guard. This is the one test here expected to be GREEN
// while a defective tag may still be pinned: it measures the CURRENT tree's
// tarball, the fixed world the P-ladder is read against.
test('G1 GUARD: the current tree refuses both acquisition subpaths in sememe\'s voice', () => {
  const app = packAndInstall({ tag: null, omitPeer: true });
  for (const subpath of ['sememe/pull', 'sememe/gap']) {
    const r = importSubpath(app.dir, subpath);
    assert.equal(r.imported, false, `${subpath} must be refused`);
    assert.match(r.message, /npm i @solana\/web3\.js/, `${subpath} must name the install command`);
    assert.notEqual(r.code, 'ERR_MODULE_NOT_FOUND', `${subpath} must not leak the raw loader error`);
  }
  // and the CLI wraps once there too
  const cli = spawnSync(process.execPath, [
    path.join(app.app, 'bin', 'sememe.mjs'), 'pull', '11111111111111111111111111111111',
  ], { cwd: app.dir, encoding: 'utf8' });
  assert.notEqual(cli.status, 0, 'pull must refuse without the peer');
  const out = cli.stdout + cli.stderr;
  assert.equal(out.split('install it next to sememe').length - 1, 1, `instruction must appear once: ${out.trim()}`);
});
