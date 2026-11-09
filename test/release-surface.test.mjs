// The release surface is a CONTRACT, not decoration: sememe deliberately does
// not publish to the npm registry (README: no name squatting; the git tag IS
// the release artifact), so the two surfaces a stranger touches BEFORE
// installing are:
//
//   1. the GitHub Releases page,
//   2. the README's install command and the claims printed around it.
//
// MEASURED 2026-11-05 (pre-fix tree 8cb2e13), research/release-surface-2026-11-05-before.json:
//   C1  five tags (v0.1.1..v0.3.0), ZERO release pages — /releases is empty.
//   C4  the README documents `sememe gap` (bash block) and `sememe/raydium`
//       (exports sentence) while pinning `npm install ...#v0.3.0` — that
//       tree (25 commits behind main) has neither: the copy-paste install
//       yields a package the README around it does not describe.
//   C5  the status line claims "account state, all runnable" while the
//       pull-section Limit still says "Account and event decoding ... remain
//       proposals; only instruction data is decoded today" — the README
//       asserts P and not-P about the same product.
//
// Ladder (written FIRST against 8cb2e13):
//   T1   the instrument exists and enforces its CLI contract (exit 0 measured,
//        exit 3 no-verdict — a network failure is never an absence)
//   T2   the MEASURED pre-fix surface, as a fixture, is named defect by defect
//   T3   the post-fix surface (release page for the newest tag, install pin
//        delivering everything the README documents, README consistent) -> clean
//   T4   malformed/network-failed input -> NO VERDICT, never "clean"
//   T5   (guard) a README that only ships the status claim without the stale
//        proposal sentence is NOT a contradiction — fixing one side suffices
//   T6   (guard) prose mentioning `sememe gap` without a bash block is not a
//        documented command — the extraction rule must not over-reach
//   T7   the LIVE README on this tree must not self-contradict — RED on 8cb2e13
//   T8   the committed before-artifact is the one the tool derives (no
//        hand-edited verdict) and records the defects above
//   T9   the committed after-artifact exists, is clean, and reproduces
//   T10  (network, opt-in) a live re-measure agrees with the committed
//        after-artifact while the surface is unchanged
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-release-surface.mjs');
const BEFORE = path.join(ROOT, 'research', 'release-surface-2026-11-05-before.json');
// The after-artifact moves WITH the release: each one records the surface as
// it was measured (measuredAt, full release bodies, local tags, HEAD README,
// the tag trees). Older records stay in research/ as history — they still
// reproduce their own verdict — but the artifact that must be clean is the
// one committed with the CURRENT release. Three releases were cut on
// 2026-11-07, so the record is date-suffixed: release-surface-2026-11-07.json
// is the v0.4.7-era record (superseded that same day),
// release-surface-2026-11-07b.json is the v0.4.8 one,
// release-surface-2026-11-07c.json the v0.4.8-era re-measure after the
// pin-derived journey, release-surface-2026-11-07d.json is the v0.4.9 one,
// and release-surface-2026-11-07e.json is the v0.4.10 one,
// and release-surface-2026-11-07f.json the v0.4.11 one,
// and release-surface-2026-11-08.json the v0.4.12 one,
// and release-surface-2026-11-09.json the v0.4.13 one this file pins
// (newest = latest = pinned = v0.4.13).
const AFTER = path.join(ROOT, 'research', 'release-surface-2026-11-09.json');
const NETWORK = process.env.SEMEME_RELEASE_SURFACE_NETWORK === '1';

// On the pre-fix tree the tool module does not exist; the import failure must
// fail this file RED, never pass silently.
let derive, parseReadme, codeBlocks;

test.before(async () => {
  const mod = await import(new URL(`file://${TOOL}`).href);
  ({ derive, parseReadme, codeBlocks } = mod);
});

// ---------------------------------------------------------- measured inputs

// Extracted verbatim from the pre-fix tree (8cb2e13) — this is what the tool
// measured, not a guess: README status fragment "account state, all runnable"
// (line 5), Limit fragment "only instruction data is decoded today" (line 183),
// bash-block commands {pull, gap, decode, account, adopt}, backticked export
// subpaths incl. raydium, install pins [#v0.3.0].
const preReadme = {
  installTags: ['v0.3.0'],
  documentedCommands: ['pull', 'gap', 'decode', 'account', 'adopt'],
  documentedExports: ['token', 'raydium', 'store', 'pull', 'native-corpus', 'native-audit', 'native', 'discriminators', 'codec', 'canonical'],
  shippedAccountEvent: true,
  proposalInstructionOnly: true,
  // measured: the sentence exists verbatim in the v0.3.0-era README
  peerRefusalCommands: ['pull'],
};

// The v0.3.0 tag tree as measured (git show v0.3.0:{package.json,bin/sememe.mjs,README.md}):
// no gap command, no src/raydium.mjs in the exports map, its own README is
// internally consistent (documents only what it ships) and pins its own tag.
const tagV030Tree = {
  manifest: { version: '0.3.0', private: false },
  binCommands: ['account', 'adopt', 'decode', 'decode-native', 'decode-token', 'native-provenance', 'pull', 'token-provenance'],
  exports: ['.', 'native', 'store', 'pull', 'codec', 'canonical', 'discriminators', 'native-corpus', 'native-audit', 'package.json', 'token'],
  // measured on the v0.3.0 tree: gap does not exist yet, so the refusal
  // claim ("refuses sememe pull ... every other subcommand") was TRUE there
  peerNeeds: { commands: ['pull'], unknownCommands: [] },
  readme: {
    installTags: ['v0.3.0'],
    documentedCommands: ['pull', 'decode', 'account', 'adopt'],
    documentedExports: ['token', 'store', 'pull', 'native-corpus', 'native-audit', 'native', 'discriminators', 'codec', 'canonical'],
    shippedAccountEvent: true,
    proposalInstructionOnly: true,
    hasQuickstart: false,
  },
};

const preFixInput = {
  releases: [],
  tags: ['v0.1.1', 'v0.2.0', 'v0.2.1', 'v0.2.2', 'v0.3.0'],
  readme: preReadme,
  trees: { 'v0.3.0': tagV030Tree },
};

// ------------------------------------------------------------- the fixtures

const honestBody = (tag) =>
  [
    '## Install (no npm account needed)',
    '',
    '```bash',
    `npm install github:auroraxo/sememe#${tag}`,
    '```',
    '',
    '```js',
    "import { decodePayload } from 'sememe';",
    '```',
    '',
    'The registry name is deliberately unpublished: the git tag is the release artifact.',
    '',
    '## Honest limits',
    '',
    'No external users yet (0 non-owner signals), no audit, own-host measurement.',
  ].join('\n');

const postFixInput = {
  releases: [
    { tag: 'v0.4.0', body: honestBody('v0.4.0'), draft: false, prerelease: false, publishedAt: '2026-11-05T05:30:00Z' },
  ],
  tags: ['v0.1.1', 'v0.2.0', 'v0.2.1', 'v0.2.2', 'v0.3.0', 'v0.4.0'],
  readme: {
    installTags: ['v0.4.0'],
    documentedCommands: ['pull', 'gap', 'decode', 'account', 'adopt'],
    documentedExports: ['token', 'raydium', 'store', 'pull', 'native-corpus', 'native-audit', 'native', 'discriminators', 'codec', 'canonical'],
    shippedAccountEvent: true,
    proposalInstructionOnly: false,
    peerRefusalCommands: ['pull', 'gap'],
  },
  trees: {
    'v0.4.0': {
      manifest: { version: '0.4.0', private: false },
      binCommands: ['account', 'adopt', 'conform', 'decode', 'decode-native', 'decode-raydium', 'decode-token', 'gap', 'native-provenance', 'pull', 'raydium-provenance', 'token-provenance'],
      exports: ['.', 'native', 'store', 'pull', 'codec', 'canonical', 'discriminators', 'native-corpus', 'native-audit', 'package.json', 'token', 'token-metadata', 'raydium', 'gap'],
      peerNeeds: { commands: ['gap', 'pull'], unknownCommands: [] },
      readme: {
        installTags: ['v0.4.0'],
        documentedCommands: ['pull', 'gap', 'decode', 'account', 'adopt'],
        documentedExports: ['token', 'raydium', 'store', 'pull', 'native-corpus', 'native-audit', 'native', 'discriminators', 'codec', 'canonical'],
        shippedAccountEvent: true,
        proposalInstructionOnly: false,
        hasQuickstart: true,
      },
    },
  },
};

// ------------------------------------------------------------------- the tests

test('T1: the instrument exists and enforces its CLI contract', () => {
  assert.ok(existsSync(TOOL), 'tools/measure-release-surface.mjs must exist');
  const source = readFileSync(TOOL, 'utf8');
  assert.match(source, /process\.exit\(measure\(/, 'the tool must exit through measure()');
  assert.match(source, /release-list-unavailable/,
    'an unreachable release list must be NO VERDICT (exit 3), never "no releases"');
  assert.match(source, /return verdict\.noVerdict \? 3 : 0/,
    'exit 0 only when measured, exit 3 on no-verdict');
});

test('T2: the measured pre-fix surface is named defect by defect', () => {
  const v = derive(preFixInput);
  assert.strictEqual(v.noVerdict, false);
  assert.ok(v.defects.includes('missing-release-for-newest-tag'), `got: ${v.defects.join(',')}`);
  assert.ok(v.defects.includes('readme-install-tag-missing-command:gap'), `got: ${v.defects.join(',')}`);
  assert.ok(v.defects.includes('readme-install-tag-missing-export:raydium'), `got: ${v.defects.join(',')}`);
  assert.ok(v.defects.includes('readme-contradiction-decode-scope'), `got: ${v.defects.join(',')}`);
  assert.strictEqual(v.newestTag, 'v0.3.0');
  assert.strictEqual(v.latestTag, null);
  assert.strictEqual(v.verdict, 'defective:' + v.defects.join('+'));
});

test('T3: the post-fix surface (release page + delivering pin + consistent README) is clean', () => {
  const v = derive(postFixInput);
  assert.strictEqual(v.noVerdict, false, JSON.stringify(v));
  assert.deepStrictEqual(v.defects, [], `expected clean, got: ${v.defects.join(',')}`);
  assert.strictEqual(v.verdict, 'clean');
  assert.strictEqual(v.newestTag, 'v0.4.0');
  assert.strictEqual(v.latestTag, 'v0.4.0');
});

test('T4: malformed or network-failed input is NO VERDICT, never an absence', () => {
  const { releases: _r, tags: _t, ...rest } = postFixInput;
  assert.strictEqual(derive({ ...rest, releases: null }).noVerdict, true);
  assert.strictEqual(derive({ ...rest, releases: null }).verdict, 'no-verdict');
  assert.strictEqual(derive({ ...postFixInput, tags: null }).noVerdict, true);
  // a tree that cannot be read is unmeasurable, never clean
  const pinnedTreeOnly = {
    ...postFixInput,
    readme: { ...postFixInput.readme, installTags: ['v0.3.0'] },
    trees: { 'v0.3.0': tagV030Tree }, // the release v0.4.0's tree is absent
  };
  const v = derive(pinnedTreeOnly);
  assert.strictEqual(v.noVerdict, true, 'a release without a readable tree must not verdict clean');
  assert.match(v.reason, /release-tree-unreadable/);
  const v2 = derive({ ...postFixInput, trees: {} });
  assert.strictEqual(v2.noVerdict, true, 'a pinned install tag without a readable tree must not verdict clean');
  assert.match(v2.reason, /install-tag-tree-unreadable/);
});

test('T5 (guard): shipping the status claim without the stale proposal sentence is not a contradiction', () => {
  const fixedSideOnly = { ...preReadme, proposalInstructionOnly: false };
  const v = derive({ ...preFixInput, readme: fixedSideOnly });
  assert.ok(!v.defects.includes('readme-contradiction-decode-scope'),
    `fixing the stale sentence alone must clear the contradiction, got: ${v.defects.join(',')}`);
  // ...and the other side: no status claim, stale sentence present -> also not a contradiction
  const noStatus = { ...preReadme, shippedAccountEvent: false };
  const v2 = derive({ ...preFixInput, readme: noStatus });
  assert.ok(!v2.defects.includes('readme-contradiction-decode-scope'));
});

test('T6 (guard): prose mentioning sememe gap without a bash block is not a documented command', () => {
  const proseOnly = parseReadme(
    '# sememe\n\nA future `sememe gap` would be nice.\n\n## Install\n\nnpm install github:auroraxo/sememe#v0.4.0\n'
  );
  assert.ok(!proseOnly.documentedCommands.includes('gap'),
    `extraction must read fenced bash blocks only, got: ${proseOnly.documentedCommands.join(',')}`);
  const bash = parseReadme('```bash\nnode bin/sememe.mjs gap DCA265\n```\n');
  assert.ok(bash.documentedCommands.includes('gap'), 'a real bash block must count');
});

test('T6b: the two extraction false positives measured on 2026-11-05 stay dead', () => {
  // (1) a ```json output block that QUOTES a command is not documentation;
  // (2) the quickstart's own `git clone .../sememe && cd sememe` followed by
  //     `node tools/...` must never produce a command named "node".
  const md = [
    '```bash',
    'git clone https://github.com/auroraxo/sememe && cd sememe',
    'node tools/stranger-decode.mjs \\',
    '  --store test/fixtures/traffic-sample-store-2026-11-04',
    '```',
    '',
    '```json',
    '{"next": "sememe pull DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M"}',
    '```',
  ].join('\n');
  const p = parseReadme(md);
  assert.deepStrictEqual(p.documentedCommands, [], `expected no commands, got: ${p.documentedCommands.join(',')}`);
  assert.ok(!p.documentedCommands.includes('node'), 'the clone/run line is not a sememe command');
  assert.ok(!p.documentedCommands.includes('pull'), 'a quoted command inside JSON output is not documentation');
});

test('T6c: exports-map keys normalize before they are compared', async () => {
  const { normalizeExportsKeys } = await import(new URL(`file://${TOOL}`).href);
  assert.deepStrictEqual(normalizeExportsKeys({ '.': './index.mjs', './native': './src/native.mjs' }), ['.', 'native'],
    'the npm exports map is prefixed (./native); a documented subpath is not — the live run flagged every export as missing before this normalization');
});

test('T6d: the comparison normalizes INSIDE the pure rules, not in the caller', () => {
  // The raw npm exports map shape ("./native") must still satisfy a
  // documented subpath ("native") — the verdict may not depend on how the
  // caller shaped the tree.
  const v = derive({
    ...postFixInput,
    trees: {
      'v0.4.0': {
        ...postFixInput.trees['v0.4.0'],
        exports: postFixInput.trees['v0.4.0'].exports.map((k) => (k === '.' ? '.' : `./${k}`)),
      },
    },
  });
  assert.strictEqual(v.noVerdict, false, JSON.stringify(v));
  assert.ok(!v.defects.some((d) => d.startsWith('readme-install-tag-missing-export')),
    `the raw "./native" shape must not be read as missing, got: ${v.defects.join(',')}`);
});

test('T7: the live README on this tree must not assert P and not-P about decode scope', () => {
  const live = parseReadme(readFileSync(path.join(ROOT, 'README.md'), 'utf8'));
  assert.ok(live.shippedAccountEvent, 'the status claim is present and fine');
  assert.strictEqual(live.proposalInstructionOnly, false,
    'README still says "only instruction data is decoded today" / "Account and event decoding ... remain proposals" while the status line ships account+event decode — the two contradict');
});

test('T8: the committed before-artifact is the one the tool derives, defects included', () => {
  assert.ok(existsSync(BEFORE), 'research/release-surface-2026-11-05-before.json must be committed');
  const artifact = JSON.parse(readFileSync(BEFORE, 'utf8'));
  assert.strictEqual(artifact.noVerdict, false);
  const { releases, tags, readme, trees } = artifact.surfaces;
  const again = derive({ releases, tags, readme, trees });
  assert.strictEqual(again.verdict, artifact.verdict.verdict,
    'the committed verdict must be reproducible from the committed inputs (no hand-edited verdict)');
  for (const defect of [
    'missing-release-for-newest-tag',
    'readme-install-tag-missing-command:gap',
    'readme-install-tag-missing-export:raydium',
    'readme-contradiction-decode-scope',
  ]) {
    assert.ok(artifact.verdict.defects.includes(defect), `before-artifact must record ${defect}, got: ${artifact.verdict.defects.join(',')}`);
  }
});

test('T9: the committed after-artifact exists, is clean, and reproduces', () => {
  assert.ok(existsSync(AFTER), 'the after-artifact committed with the current release must be in research/');
  const artifact = JSON.parse(readFileSync(AFTER, 'utf8'));
  assert.strictEqual(artifact.noVerdict, false);
  const { releases, tags, readme, trees } = artifact.surfaces;
  const again = derive({ releases, tags, readme, trees });
  assert.strictEqual(again.verdict, artifact.verdict.verdict, 'committed verdict must reproduce from committed inputs');
  assert.strictEqual(artifact.verdict.verdict, 'clean', `expected clean, got: ${artifact.verdict.verdict}`);
  assert.strictEqual(artifact.verdict.newestTag, artifact.verdict.latestTag, 'Latest must point at the newest tag');
});

test('T10: a live re-measure agrees with the committed after-artifact', { skip: NETWORK ? false : 'network measurement: set SEMEME_RELEASE_SURFACE_NETWORK=1' }, () => {
  const out = path.join(ROOT, 'research', 'release-surface-live.tmp.json');
  execFileSync('node', [TOOL, '--out', out], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
  const live = JSON.parse(readFileSync(out, 'utf8'));
  const committed = JSON.parse(readFileSync(AFTER, 'utf8'));
  assert.strictEqual(live.verdict.verdict, committed.verdict.verdict,
    'the surface drifted since the committed artifact — re-measure and decide, do not assume');
});

test('T-codeblocks: code blocks are what carry API claims (used by the body rules)', () => {
  assert.deepStrictEqual(codeBlocks('prose mentioning `require("sememe")` inline'), []);
  assert.strictEqual(codeBlocks('text\n```js\nrequire("sememe");\n```\n').length, 1);
});

test('T11: release-body claims are checked where they are checkable', async () => {
  const { bodyDefects, bodyImportNames } = await import(new URL(`file://${TOOL}`).href);
  const tree = { entryExports: ['decodePayload', 'decodeUnionPayload'] };

  // an import of a name the entry does not export is a false claim
  const bad = bodyDefects('v0.4.0', tree, `${honestBody('v0.4.0')}\n\n\`\`\`js\nimport { Signerd } from 'sememe';\n\`\`\`\n`);
  assert.ok(bad.includes('body-nonexistent-api'), `got: ${bad.join(',')}`);
  assert.deepStrictEqual(bodyImportNames(honestBody('v0.4.0')), ['decodePayload'], 'honest body imports the real entry API');

  // no cargo install: this repo has no Cargo.toml (measured)
  const cargo = bodyDefects('v0.4.0', tree, `${honestBody('v0.4.0')}\n\ncargo install --git https://github.com/auroraxo/sememe\n`);
  assert.ok(cargo.includes('body-advertises-cargo-install'), `got: ${cargo.join(',')}`);

  // a body with no limit statement is a defect (the honest limits line is part of the contract)
  const noLimits = bodyDefects('v0.4.0', tree, 'install: npm install github:auroraxo/sememe#v0.4.0\n');
  assert.ok(noLimits.includes('body-no-limits'), `got: ${noLimits.join(',')}`);

  // the honest body is clean
  assert.deepStrictEqual(bodyDefects('v0.4.0', tree, honestBody('v0.4.0')), []);
});

test('T13: peerNeedsOf derives the peer-needing commands from the import graph', async () => {
  // Synthetic graph: bin dispatches pull -> pull.mjs (web3) and gap -> gap.mjs
  // -> acquire.mjs (web3); every other command resolves to web3-free files.
  const files = {
    'bin/src/pull.mjs': "import { PublicKey } from '@solana/web3.js';\nimport { addresses } from './acquire.mjs';\n",
    'bin/src/gap.mjs': "import { addresses } from './acquire.mjs';\n",
    'bin/src/acquire.mjs': "import { PublicKey } from '@solana/web3.js';\n",
    'bin/src/decode.mjs': "import { decodeHex } from './codec.mjs';\n",
    'bin/src/codec.mjs': "import { canonicalJson } from './canonical.mjs';\n",
    'bin/src/canonical.mjs': "// node: only\n",
    'bin/src/conformance.mjs': "import { check } from './account-list.mjs';\n",
    'bin/src/account-list.mjs': "// node: only\n",
  };
  const resolve = (rel) => (rel in files ? files[rel] : null);
  const bin = [
    "if (command === 'absent-help') { nope(); }",
    "else if (command === 'pull') { const m = await import('./src/pull.mjs'); }",
    "else if (command === 'gap') { const m = await import('./src/gap.mjs'); }",
    "else if (command === 'adopt') { const m = await import('./src/decode.mjs'); }",
    "else if (command === 'conform') { const m = await import('./src/conformance.mjs'); }",
    "else if (command === 'decode') { staticAlready(); }",
  ].join('\n');
  const { peerNeedsOf } = await import(new URL(`file://${TOOL}`).href);
  const needs = peerNeedsOf(bin, resolve);
  assert.deepStrictEqual(needs.commands, ['gap', 'pull'], `got: ${JSON.stringify(needs)}`);
  assert.deepStrictEqual(needs.unknownCommands, [], `got: ${JSON.stringify(needs)}`);
  // a command whose segment has no imports belongs to nobody
  const bare = peerNeedsOf("if (command === 'decode') { help(); }", resolve);
  assert.deepStrictEqual(bare.commands, []);
  // an unresolvable import graph is REPORTED, never silently read as clean
  const unknown = peerNeedsOf("else if (command === 'gap') { await import('./src/gap.mjs'); }", () => null);
  assert.deepStrictEqual(unknown.commands, []);
  assert.deepStrictEqual(unknown.unknownCommands, ['gap']);
  // a cycle must not hang: gap -> acquire -> gap
  const cyclic = peerNeedsOf(
    "else if (command === 'gap') { await import('./src/gap.mjs'); }",
    (rel) => (rel === 'bin/src/gap.mjs' ? "import { x } from './acquire.mjs';\n" : "import { y } from './gap.mjs';\n"),
  );
  assert.deepStrictEqual(cyclic.commands, []);
  assert.deepStrictEqual(cyclic.unknownCommands, []);
});

test('T14: the README refusal-scope claim must cover every peer-needing command the pinned tree has', async () => {
  const base = {
    releases: [{ tag: 'v0.4.0', body: honestBody('v0.4.0'), draft: false, prerelease: false, publishedAt: '2026-11-05T05:30:00Z' }],
    tags: ['v0.4.0'],
    trees: { 'v0.4.0': postFixInput.trees['v0.4.0'] },
  };
  // the measured live defect (2026-11-05): claim names only pull, tree needs pull+gap
  const falseClaim = derive({ ...base, readme: { ...postFixInput.readme, peerRefusalCommands: ['pull'] } });
  assert.ok(falseClaim.defects.includes('readme-peer-scope-claim-false:gap'), `got: ${falseClaim.defects.join(',')}`);
  // the fixed world: claim names both -> no defect
  const trueClaim = derive({ ...base, readme: { ...postFixInput.readme, peerRefusalCommands: ['pull', 'gap'] } });
  assert.ok(!trueClaim.defects.some((d) => d.startsWith('readme-peer-scope-claim-false')), `got: ${trueClaim.defects.join(',')}`);
  // guard: no claim sentence at all + peer-free tree -> no defect (rule only binds real peer needs)
  const peerFree = derive({ ...base, trees: { 'v0.4.0': { ...postFixInput.trees['v0.4.0'], peerNeeds: { commands: [], unknownCommands: [] } } }, readme: { ...postFixInput.readme, peerRefusalCommands: [] } });
  assert.ok(!peerFree.defects.some((d) => d.startsWith('readme-peer-scope-claim-false')), `got: ${peerFree.defects.join(',')}`);
});

test('T15: the LIVE repo — README refusal claim covers the pinned tree\'s real peer needs', async () => {
  const { peerNeedsOf } = await import(new URL(`file://${TOOL}`).href);
  const liveReadme = parseReadme(readFileSync(path.join(ROOT, 'README.md'), 'utf8'));
  const show = (p) => execFileSync('git', ['show', `HEAD:${p}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const resolve = (rel) => {
    const p = path.posix.normalize(rel);
    try { return show(p); } catch { return null; }
  };
  const needs = peerNeedsOf(show('bin/sememe.mjs'), resolve);
  assert.deepStrictEqual(needs.unknownCommands, [], `unresolved graph segments must be fixed, got: ${JSON.stringify(needs)}`);
  for (const cmd of needs.commands) {
    assert.ok(liveReadme.peerRefusalCommands.includes(cmd),
      `README claims only ${JSON.stringify(liveReadme.peerRefusalCommands)} refuse without @solana/web3.js, but the tree derives ${cmd} too — copy-paste install yields a gap the README around it does not describe`);
  }
});

test('T12: a body whose install command names a tag this repo does not have is a false claim', () => {
  const v = derive({
    ...postFixInput,
    releases: [{ tag: 'v0.4.0', body: honestBody('v9.9.9'), draft: false, prerelease: false, publishedAt: '2026-11-05T05:30:00Z' }],
  });
  assert.strictEqual(v.noVerdict, false);
  assert.ok(v.defects.includes('v0.4.0:body-install-tag-missing'), `got: ${v.defects.join(',')}`);
});
