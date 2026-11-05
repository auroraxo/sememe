// The lock journey is a CONTRACT, not decoration: the README section
// "Working now: pin the answers" tells a stranger to run `sememe lock` and
// `sememe verify` — and the front page pins `npm install
// github:auroraxo/sememe#vX.Y.Z`, so the commands a pinned install can run
// are the ones inside the TAG's tree, not main's.
//
// MEASURED 2026-11-05 (tree b8465bf pinning v0.4.3, packed tarball + fixture
// store, ladder at the bottom):
//   L1  the v0.4.3 tarball (the bytes a github:#v0.4.3 install receives) has
//       NO lock at all: src/lock.mjs is absent, so the documented
//       `npx sememe lock --store ./store --out ./sememe.lock` exits 2 with
//       the usage dump (unknown-command branch) and writes NO lock file.
//       The README a stranger reads says the lockfile "ships".
//   L2  the README's own lock section is a dead end on a fresh clone:
//       the two documented commands run against `--store /tmp/sememe-demo`,
//       but NOTHING in the documented sequence creates that store — the
//       pull step is documented in a LATER section. Measured verbatim:
//       `node bin/sememe.mjs lock --store /tmp/sememe-demo ...` on a fresh
//       machine exits 1 with `no sememe store at /tmp/sememe-demo`.
//
// Both defects are the same class the repo measured three times before
// (v0.4.1 journey dead-ends, elided payload, peer-refusal claim): the
// documented surface promises something the pinned bytes or the documented
// sequence cannot deliver. L1 can only be fixed by a NEW TAG whose tree
// carries src/lock.mjs; L2 is fixed by reordering the README so the lock
// commands run against the store the same README has the reader create.
//
// This test reads the PACKED TARBALL of the pinned tag (npm pack of an
// exported tag worktree — the exact bytes a `github:#<tag>` install
// receives) and runs the lock journey verbatim from the installed tree
// against the committed fixture store (offline — no network, no clone
// paths). Like installed-tag-journey.test.mjs, a tag that is not
// published yet is a NAMED SKIP, never a silent green over a different
// tree.
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

// npm pack of an EXPORTED TAG WORKTREE (same mechanism as
// installed-tag-journey.test.mjs; shared deliberately so both journeys
// measure the same bytes). Skips with a named reason when the pinned tag
// is neither local nor fetchable.
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
    TAGPACK = { dir, app, readme: fs.readFileSync(path.join(app, 'README.md'), 'utf8') };
    return TAGPACK;
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', work], { cwd: ROOT, stdio: 'pipe' });
  }
}

const PIN = pinnedTag();

let ctx = null;
let skipReason = null;
try {
  ctx = tagTarball(PIN);
} catch (err) {
  if (!(err instanceof SkipUnmeasurableTag)) throw err;
  skipReason = err.message;
}

// The fixture store the journey test copies: lock/verify are offline, so the
// documented journey is measurable end to end without a pull.
const FIXTURE_STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04');

// Extract the README's lock section and its fenced bash command lines — the
// documented commands, exactly as a stranger copies them.
function lockSectionOf(readme) {
  const start = readme.indexOf('## Working now: pin the answers');
  assert.ok(start >= 0, 'README must document the lock section');
  const next = readme.indexOf('## ', start + 10);
  return readme.slice(start, next === -1 ? undefined : next);
}

function fencedCommands(section) {
  return [...section.matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap(([, block]) => block.split('\n'))
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.endsWith('\\'));
}

// A DOCUMENTED COMMAND is a command LINE, never prose: the repo's own rule
// (release-surface T6) — prose mentioning `sememe pull` inside backticks is
// not a command a stranger can run. Both forms are accepted (the clone form
// `bin/sememe.mjs pull` and the install form `npx sememe pull`).
function isPullCommand(line) {
  return /(?:^|\s)(?:npx\s+)?(?:node\s+)?(?:bin\/sememe\.mjs|sememe)\s+pull\b/.test(line);
}

test(`L1: the pinned tag (${PIN}) ships the lock the README says ships — documented lock journey runs verbatim from the bare install`, { skip: skipReason || false }, async () => {
  const section = lockSectionOf(ctx.readme);
  // The commands the TAG's README documents, exactly as a stranger copies them.
  const docLines = [...section.matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap(([, block]) => block.split('\n'))
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const pullLine = docLines.find((l) => /^npx sememe pull\b/.test(l));
  const lockLine = docLines.find((l) => /^npx sememe lock\b/.test(l));
  const verifyLine = docLines.find((l) => /^npx sememe verify\b/.test(l));
  assert.ok(lockLine, 'lock section must document an npx-runnable lock command');
  assert.ok(verifyLine, 'lock section must document an npx-runnable verify command');
  assert.ok(pullLine, 'lock section must document the pull that creates the store before lock needs it');

  // The installed tree must answer them. The live pull is replaced by the
  // committed fixture store (offline): same store shape the pull creates,
  // same directory name (`./store`) the documented commands use.
  const storeDst = path.join(ctx.dir, 'store');
  fs.rmSync(storeDst, { recursive: true, force: true });
  fs.cpSync(FIXTURE_STORE, storeDst, { recursive: true });
  fs.rmSync(path.join(ctx.dir, 'sememe.lock'), { force: true });
  for (const line of [lockLine, verifyLine]) {
    const out = spawnSync('bash', ['-c', line], { cwd: ctx.dir, encoding: 'utf8' });
    assert.equal(out.status, 0, `documented command must run on the pinned install: "${line}" -> exit ${out.status}: ${(out.stdout + out.stderr).slice(0, 300)}`);
  }
  assert.ok(fs.existsSync(path.join(ctx.dir, 'sememe.lock')), 'documented lock must write the lock file');
});

test(`L2: the README lock section documents a store-creating step BEFORE the lock command that needs it`, () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const section = lockSectionOf(readme);
  const lines = fencedCommands(section);
  const firstNeedsStore = lines.find((l) => /--store\b/.test(l) && /(?:bin\/sememe\.mjs|npx sememe)\s+(?:lock|verify)\b/.test(l));
  assert.ok(firstNeedsStore, 'lock section must document its store-consuming command');
  const createsStore = lines.findIndex(isPullCommand);
  const needsIndex = lines.indexOf(firstNeedsStore);
  assert.ok(
    createsStore >= 0 && createsStore < needsIndex,
    `lock section documents ${firstNeedsStore} but no sememe pull command before it — on a fresh machine it dies with "no sememe store" (measured verbatim 2026-11-05, exit 1)`
  );
});

// G1 keeps main honest while a still-unfixed tag may exist: the CURRENT
// tree's lock section must keep the pull step and keep the npx form
// documented in prose, so this file's guard cannot silently regress.
test('G1 (guard): the current tree lock section keeps the runnable journey (pull command before lock, npx form documented)', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const section = lockSectionOf(readme);
  assert.ok(/npx sememe lock/.test(section), 'main README must document the npx lock form');
  assert.ok(/npx sememe verify/.test(section), 'main README must document the npx verify form');
  const lines = fencedCommands(section);
  assert.ok(
    lines.some(isPullCommand),
    'main README lock section must carry a runnable pull command that creates the store the lock needs'
  );
});
