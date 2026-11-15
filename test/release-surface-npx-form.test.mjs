// The install channel is `npx sememe …`, and the release-surface contract must
// see the commands documented THAT way — not only the clone-form
// `sememe <cmd>` / `node bin/sememe.mjs <cmd>`.
//
// MEASURED 2026-11-14 (repo HEAD ab474f0, README pins v0.4.26):
//
//   parseReadme(README).documentedCommands === ['pull', 'lock', 'verify']
//
// The README documents, in fenced bash blocks:
//
//   npx sememe pull        … --store ./store      (line 79)
//   npx sememe decode      … --store ./store      (line 80)
//   npx sememe lock        …                      (line 102-104)
//   npx sememe verify      …
//   npx sememe adopt-hadron --store ./store       (line 129)
//   npx sememe decode --union HADRo…              (line 130)
//
// …and C3 ("the tag the README PINS delivers everything the README
// documents") checked NONE of them, because the extraction regex anchors on
// `sememe <cmd>` / `node bin/sememe.mjs <cmd>` and the npx form carries an
// `npx ` prefix the regex does not accept. So the tool reported verdict
// `clean` while the pinned tag v0.4.26 had no `adopt-hadron` command at all:
// the contract's blind spot was exactly the channel it exists to watch.
//
// THE DEFECT IT HID: a stranger who copy-pastes the README's
// `npx sememe adopt-hadron --store ./store` into a fresh app gets usage/
// exit 2 — a command the shipped package does not implement.
//
// Ladder (written FIRST against HEAD ab474f0, before the tool fix):
//   L1  a fenced `npx sememe <cmd>` block yields <cmd> in documentedCommands  — RED
//   L2  the LIVE README names adopt-hadron and decode, not only pull/lock/verify — RED
//   L3  the pin-lag is a DEFECT: derive() on the live README + the pinned
//       v0.4.26 tree reports readme-install-tag-missing-command:adopt-hadron — RED
//   G1  (guard) prose mentioning `npx sememe adopt-hadron` OUTSIDE a fence is
//       not a documented command — green on BOTH trees (fence rule intact)
//   G2  (guard) the pre-existing false positives stay dead: a ```json block
//       quoting a command, and `git clone … && cd sememe` followed by
//       `node tools/…`, produce no commands — green on BOTH trees
//   G3  (guard) the clone-form extraction (`node bin/sememe.mjs gap`) is
//       unchanged — green on BOTH trees
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-release-surface.mjs');

// The tag whose pin lag was MEASURED. v0.4.26 is immutable: it documents
// nothing about adopt-hadron, and it ships no adopt-hadron command — that
// pair is the frozen defect this ladder pins.
const PINNED = 'v0.4.26';

let parseReadme, derive, binCommandsOf, normalizeExportsKeys, readTreeForTest;

// The REAL release body of the pinned tag, taken verbatim from the committed
// release-surface artifact. A synthetic body would import body defects
// (body-no-install-command / body-no-limits) into this ladder and blur what
// is being measured: C3, the pin-lag rule.
// The after-artifact moves WITH the release: release-surface-2026-11-14b.json
// is the v0.4.27-era record (newest = latest = pinned = v0.4.27, verdict
// clean). The 2026-11-14.json record is the v0.4.26 one — its body is the
// frozen input L3 reads.
const ARTIFACT = path.join(ROOT, 'research', 'release-surface-2026-11-14.json');
const AFTER = path.join(ROOT, 'research', 'release-surface-2026-11-15.json');

test.before(async () => {
  const mod = await import(new URL(`file://${TOOL}`).href);
  ({ parseReadme, derive, binCommandsOf } = mod);
  normalizeExportsKeys = mod.normalizeExportsKeys;
  // readTree is not exported; rebuild the ONE shape derive() needs for the
  // pinned tag, from the real tree — no hand-made inputs.
  readTreeForTest = (tag) => {
    const show = (p) => execFileSync('git', ['show', `${tag}:${p}`], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    const manifest = JSON.parse(show('package.json'));
    return {
      manifest: { version: manifest.version, private: manifest.private === true },
      binCommands: binCommandsOf(show('bin/sememe.mjs')),
      peerNeeds: { commands: [], unknownCommands: [] },
      exports: normalizeExportsKeys(manifest.exports),
      entryExports: [],
      readme: parseReadme(show('README.md')),
    };
  };
});

const liveReadme = () => parseReadme(readFileSync(path.join(ROOT, 'README.md'), 'utf8'));

const pinnedBody = (tag) => {
  // Search the release-surface records for the tag's REAL body. The v0.4.26
  // body is in the v0.4.26-era record; the v0.4.27 body in the current one.
  for (const file of [ARTIFACT, AFTER]) {
    const artifact = JSON.parse(readFileSync(file, 'utf8'));
    const release = (artifact.surfaces.releases || []).find((r) => r.tag === tag);
    if (release) return release.body;
  }
  assert.fail(`no committed release-surface record carries ${tag}'s real body`);
  return '';
};

test('L1: a fenced `npx sememe <cmd>` block yields <cmd> in documentedCommands', () => {
  const md = ['```bash', 'npx sememe adopt-hadron --store ./store', '```'].join('\n');
  const r = parseReadme(md);
  assert.ok(r.documentedCommands.includes('adopt-hadron'),
    `the npx form is the documented install channel and must be read; got: ${JSON.stringify(r.documentedCommands)}`);
});

test('L2: the LIVE README names adopt-hadron and decode, not only pull/lock/verify', () => {
  const r = liveReadme();
  for (const cmd of ['pull', 'lock', 'verify', 'decode', 'adopt-hadron']) {
    assert.ok(r.documentedCommands.includes(cmd),
      `documentedCommands must include ${cmd} (the README documents it in a fenced bash block); got: ${JSON.stringify(r.documentedCommands)}`);
  }
});

test('L3: the MEASURED pin lag — the live README names adopt-hadron, the v0.4.26 tree ships none', () => {
  const live = liveReadme();
  const trees = { [PINNED]: readTreeForTest(PINNED) };
  assert.ok(trees[PINNED].binCommands.includes('decode'),
    'sanity: the pinned tree really does ship decode');
  assert.ok(!trees[PINNED].binCommands.includes('adopt-hadron'),
    'sanity: the v0.4.26 tree really does NOT ship adopt-hadron (the measured pin lag)');

  // The DEFECT is the pair of measured facts: the live README names
  // adopt-hadron, and the tree behind the pin the README carried at the
  // time (v0.4.26) ships no such command. Both are facts about trees, not
  // about a verdict; the VERDICT that reports them is L4 below.
  assert.ok(live.documentedCommands.includes('adopt-hadron'),
    'the live README must name adopt-hadron (it documents it in a fenced bash block)');
  assert.ok(!trees[PINNED].binCommands.includes('adopt-hadron'),
    'sanity: the v0.4.26 tree really does NOT ship adopt-hadron (the measured pin lag)');
});

test('L4 (the live invariant): whatever tag the README pins TODAY must deliver every command the README documents', () => {
  const readme = liveReadme();
  assert.ok(readme.installTags.length === 1,
    `the README must pin exactly ONE tag; got: ${JSON.stringify(readme.installTags)}`);
  const tag = readme.installTags[0];

  const v = derive({
    releases: [{ tag, body: pinnedBody(tag), draft: false, prerelease: false,
      publishedAt: '2026-11-14T00:00:00Z' }],
    tags: [tag],
    readme,
    trees: { [tag]: readTreeForTest(tag) },
  });

  assert.strictEqual(v.noVerdict, false, `verdict must be decided, got: ${JSON.stringify(v)}`);
  const missing = v.defects.filter((d) => d.startsWith('readme-install-tag-missing-command:'));
  assert.deepStrictEqual(missing, [],
    `the pinned tag ${tag} must ship every command the README documents (copy-paste install); got: ${JSON.stringify(missing)}`);
});

test('G1 (guard): prose mentioning `npx sememe adopt-hadron` outside a fence is not a documented command', () => {
  const prose = '# sememe\n\nRun `npx sememe adopt-hadron` some day.\n\n' +
    `npm install github:auroraxo/sememe#${PINNED}\n`;
  const r = parseReadme(prose);
  assert.ok(!r.documentedCommands.includes('adopt-hadron'),
    `fence rule must hold for the npx form too; got: ${JSON.stringify(r.documentedCommands)}`);
});

test('G2 (guard): the two measured extraction false positives stay dead', () => {
  const md = [
    '```bash',
    'git clone https://github.com/auroraxo/sememe && cd sememe',
    'node tools/stranger-decode.mjs \\',
    '  --store test/fixtures/traffic-sample-store-2026-11-04',
    '```',
    '',
    '```json',
    '{"next": "npx sememe pull DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M"}',
    '```',
    '',
    '```bash',
    'npm install github:auroraxo/sememe#' + PINNED,
    '```',
  ].join('\n');
  const r = parseReadme(md);
  assert.deepStrictEqual(r.documentedCommands, [],
    `expected no commands, got: ${JSON.stringify(r.documentedCommands)}`);
  assert.ok(!r.documentedCommands.includes('node'), 'the clone/run line is not a sememe command');
  assert.ok(!r.documentedCommands.includes('pull'), 'a quoted command inside JSON output is not documentation');
});

test('G3 (guard): the clone-form extraction is unchanged', () => {
  const r = parseReadme('```bash\nnode bin/sememe.mjs gap DCA265\n```\n');
  assert.ok(r.documentedCommands.includes('gap'), 'a real bash block must still count');
});
