// The Pinned-Install Journey is a CONTRACT, not decoration: the README a
// stranger reads on github.com/auroraxo/sememe pins
// `npm install github:auroraxo/sememe#vX.Y.Z` — so the instructions that pin
// ships are the ones inside the TAG's own README, packed into the tarball.
// A README fix that lands on main AFTER the tag (97c8c79, 2026-11-05) does
// not retroactively fix the tag: `git show v0.4.1:README.md` still carries
// the two dead-ends the install-surface contract fixed on main.
//
// MEASURED 2026-11-05 (pre-fix tree d82c25c pinning v0.4.1, tag bytes from
// the packed v0.4.1 worktree, ladder: T1/T2 RED, G1 GREEN):
//   D1  the v0.4.1 tarball's README documents no store-creation step: the
//       install-section decode example needs `./store`, but the consumer
//       section shows no pull command that creates it — the first decode
//       dies with `no sememe store at ./store: run "sememe pull" first`.
//   D2  the v0.4.1 tarball's README never documents an invocation form that
//       runs from an install: bare `sememe` is not on PATH (127),
//       `node bin/sememe.mjs` resolves only in a clone; `npx sememe`
//       — the one form that works in BOTH a clone and a bare consumer app —
//       appears 0 times in the tag README (grep-measured).
//
// T1/T2 read the PACKED TARBALL of the pinned tag (npm pack of an exported
// tag worktree), the exact bytes a `github:#<tag>` install receives. The tag
// is resolved locally or fetched from origin; if it is not published yet,
// both defect tests SKIP with that reason (named skip — never a silent pass
// over a different tree). G1 guards the current tree's README so the
// main-branch journey cannot regress while a tag still carries dead-ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// The tag the front-page README pins — single source of truth so the test
// follows the pin instead of hardcoding a moving target.
function pinnedTag() {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const m = readme.match(/github:auroraxo\/sememe#(v[\d.]+\.[\d.]+[-\w.]*)/g);
  assert.ok(m && m.length, 'README must pin an install tag');
  const tags = [...new Set(m.map((s) => s.split('#')[1]))];
  assert.equal(tags.length, 1, `README must pin exactly one tag, found ${tags.join(', ')}`);
  return tags[0];
}

class SkipUnmeasurableTag extends Error {}

// npm pack of an EXPORTED TAG WORKTREE: the bytes a github:#<tag> install
// receives (pack reads the working tree, so the tag must be materialized
// first — packing ROOT would silently measure main instead of the tag).
// CI checks out shallow without tags, so a missing tag is fetched from
// origin; if it is not published either, the measurement is SKIPPED with
// that reason — a tree that cannot be read is never read as clean.
let TAGPACK = null;
function tagTarball(tag) {
  if (TAGPACK) return TAGPACK;
  const probe = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], { cwd: ROOT });
  if (probe.status !== 0) {
    const fetched = spawnSync('git', ['fetch', '--depth', '1', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (fetched.status !== 0) {
      const why = String(fetched.stderr || '').trim().split('\n')[0];
      throw new SkipUnmeasurableTag(`pinned tag ${tag} is not local and not fetchable from origin: ${why}`);
    }
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-tag-tree-'));
  execFileSync('git', ['worktree', 'add', '--detach', work, tag], { cwd: ROOT, stdio: 'pipe' });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-tag-pack-'));
    const out = execFileSync('npm', ['pack', '--silent'], { cwd: work, encoding: 'utf8' })
      .trim()
      .split('\n')
      .pop()
      .trim();
    const tgz = path.join(dir, 'sememe.tgz');
    fs.renameSync(path.join(work, out), tgz);
    execFileSync('npm', ['init', '-y'], { cwd: dir, stdio: 'ignore' });
    execFileSync('npm', ['install', '--no-audit', '--no-fund', path.basename(tgz)], { cwd: dir, stdio: 'ignore' });
    const app = path.join(dir, 'node_modules', 'sememe');
    const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
    TAGPACK = { dir, app, readme: fs.readFileSync(path.join(app, 'README.md'), 'utf8'), pkg };
    return TAGPACK;
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', work], { cwd: ROOT, stdio: 'pipe' });
  }
}

const PIN = pinnedTag();

// Both defect tests share one context resolution: measured together or
// skipped together, so a context failure can never fake a green T1 while
// T2 measures a different tree.
let ctx = null;
let skipReason = null;
try {
  ctx = tagTarball(PIN);
} catch (err) {
  if (!(err instanceof SkipUnmeasurableTag)) throw err;
  skipReason = err.message;
}

test(`T1: the pinned tag (${PIN}) ships a README that documents the store-creation step before a decode needs it`, { skip: skipReason || false }, () => {
  const consumer = ctx.readme.split('## Working now')[0]; // consumer-facing half only
  // A runnable pull command (fenced shell command with --store), not prose:
  // prose mentions (`sememe pull` inside backticks mid-sentence) exist even in
  // the broken tag README and must not satisfy this contract.
  const runnablePull = [...consumer.matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap(([, block]) => block.split('\n'))
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .filter((l) => /\bpull\b/.test(l) && /--store\b/.test(l));
  assert.ok(
    runnablePull.length > 0,
    'shipped README consumer section must show the pull command (--store ...) that creates the store a consumer decode needs'
  );
});

test(`T2: the pinned tag (${PIN}) ships a README whose CLI form runs from an install, not only from a clone`, { skip: skipReason || false }, () => {
  const binName = Object.keys(ctx.pkg.bin || {})[0];
  assert.ok(binName, 'package must declare a bin');
  assert.ok(
    ctx.readme.includes(`npx ${binName}`),
    `shipped README must document npx ${binName} — the form that runs in a bare consumer app (bare ${binName} is not on PATH; node bin/ only resolves in a clone)`
  );
});

// T3 closes the fourth dead-end of this class, measured live on the packed
// v0.4.2 tarball (2026-11-05): the journey's decode line carried an ELIDED
// payload (`2b04ed0b1ac91e62...`), so the third verbatim command a stranger
// runs ended in `{"error":"invalid base58 character \"0\""}` — the elision's
// `...` is not base58. A documented example that cannot run is the same
// defect as a documented command that does not exist.
test(`T3: the pinned tag (${PIN}) decode example is complete and runs verbatim against the committed fixture store`, { skip: skipReason || false }, () => {
  const consumer = ctx.readme.split('## Working now')[0];
  const decodeLines = [...consumer.matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap(([, block]) => block.split('\n'))
    .map((l) => l.trim())
    .filter((l) => /^npx sememe decode\b/.test(l));
  assert.ok(decodeLines.length > 0, 'shipped README consumer section must document an npx decode command');

  for (const line of decodeLines) {
    assert.ok(!line.includes('...'), `decode example must not be elided with "...": ${line}`);
  }
  // The decoded line runs verbatim from the installed tree: the store comes
  // from the committed fixture (offline — the pull step is T1's contract,
  // measured live separately), cwd is the bare install, no repo paths.
  const line = decodeLines[0];
  const storeDst = path.join(ctx.dir, 'store');
  fs.rmSync(storeDst, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04'), storeDst, { recursive: true });
  const out = spawnSync('bash', ['-c', line], { cwd: ctx.dir, encoding: 'utf8' });
  const text = out.stdout + out.stderr;
  assert.match(text, /"name":\s*"[a-z_0-9]+"/, `documented decode must decode, got: ${text.slice(0, 400)}`);
  assert.match(text, /"roundTripByteExact":\s*true/, 'documented decode must be byte-exact');
});

test('G1 (guard): the current tree README keeps the runnable consumer journey (npx form + store step + complete decode line)', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const consumer = readme.split('## Working now')[0];
  assert.ok(readme.includes('npx sememe'), 'main README documents the npx form');
  assert.match(consumer, /npx sememe pull/, 'main README consumer journey includes the pull step');
  const decodeLines = [...consumer.matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap(([, block]) => block.split('\n'))
    .map((l) => l.trim())
    .filter((l) => /^npx sememe decode\b/.test(l));
  assert.ok(decodeLines.length > 0, 'main README documents an npx decode command');
  for (const line of decodeLines) {
    assert.ok(!line.includes('...'), `main README decode example must not be elided with "...": ${line}`);
  }
});
