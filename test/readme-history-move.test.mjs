'use strict';
// THE HISTORY MOVE IS A CONTRACT, NOT A DISAPPEARANCE TRICK.
//
// MEASURED (2026-11-13): the front page was 2841 lines — a qualification log a
// stranger had to scroll before finding `npm install`. The fix moves that log
// to docs/measured-history.md and keeps a ~120-line front page. Two failure
// modes that a green README alone cannot catch:
//
//   D1  a measured number VANISHES: the front page gets shorter by deleting
//       the claim instead of relocating it. Every anchor below was a claim the
//       old front page carried; the archive must still carry it.
//   D2  the archive link DANGLES: the README points at
//       docs/measured-history.md and the file was never committed (the npm
//       tarball ships README.md only, so a reader following the link on the
//       registry page must land on a real file in the repository).
//
// THE LADDER (measured): D1/D2 both RED on the pre-move tree — no
// docs/measured-history.md exists there, so every assertion here fails.
// After the move: green. The line-budget guard is the third leg: it fails if
// the front page grows back into the log.
//
// This file deliberately does NOT re-assert what test/quickstart-funnel,
// test/release-surface and test/installed-tag-journey already pin (the
// quickstart block, the single tag pin, the npx journey, the peer-refusal
// sentence). It covers only the move.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const README = path.join(ROOT, 'README.md');
const HISTORY = path.join(ROOT, 'docs', 'measured-history.md');

const readme = fs.readFileSync(README, 'utf8');
const history = fs.existsSync(HISTORY) ? fs.readFileSync(HISTORY, 'utf8') : null;

// Anchors the OLD front page carried. Each is a claim that must still exist
// verbatim somewhere a reader can reach — relocated, never deleted.
// Format: [needle, why it must survive].
const ANCHORS = [
  // headline measurement
  ['18,895/21,350 payloads', 'the ecosystem coverage denominator'],
  ['96.4%', 'the curated-watchlist coverage'],
  ['62.4%', 'the outside-the-watchlist coverage'],
  ['915/996', 'the pump.fun union-decode result'],
  ['1,410 ATA payloads', 'the ATA acquisition-gap closing'],
  ['1,214 Lighthouse payloads', 'the Lighthouse first-party adoption'],
  // per-program record
  ['Verified against an external oracle at scale', 'the Whirlpool oracle section'],
  ['Second real program: Jupiter AMM v6', 'the Jupiter section'],
  ['Third real program, family-distant: Kamino Lend', 'the Kamino section'],
  ['Eleventh program, third wire form: cp-amm', 'the cp-amm section'],
  // defect record
  ['A filter that selects nothing is a refusal', 'the empty-filter gate'],
  ['A lock that pins nothing is a refusal', 'the empty-lock gate'],
  ['A dialect it does not speak is a NAMED refusal', 'the dialect gate'],
  ['The product SPEAKS the dialect it named', 'the raw-LE engine record'],
  ['v0.4.23 / v0.4.24: struct-internal absent fields', 'the struct-absent record'],
  // honest limits (deleting these would make the archive LESS honest than the
  // front page it replaces)
  ['Evidence and limits', 'the limits section'],
  ['Next qualification', 'the open-gate section'],
  ['Free and paid', 'the pricing section'],
];

test('D2: the archive exists and the README links to a file that ships', () => {
  assert.ok(history !== null,
    'docs/measured-history.md is missing — the README promises it and a reader following the link from the npm page finds a 404');
  assert.match(readme, /docs\/measured-history\.md/,
    'the front page must point at the archive it claims to have moved the history into');
  assert.match(history, /^> \*\*Archived measurement history\.\*\*/,
    'the archive must open with the banner that says what it is and where paths resolve from');
});

test('D1: no measured claim was deleted — every anchor lives in the archive', () => {
  assert.ok(history !== null, 'no archive to check against');
  const missing = ANCHORS.filter(([needle]) => !history.includes(needle));
  assert.deepEqual(missing.map(([n]) => n), [],
    `these claims existed on the old front page and are now nowhere: ${missing.map(([n]) => n).join(' | ')}`);
});

test('D1b: the claims the front page still makes are the ones it still backs', () => {
  // The status line keeps the headline numbers; they must be duplicated in the
  // archive (so the archive is a superset), not moved-with-a-typo.
  if (!history) return assert.fail('no archive');
  for (const needle of ['88.5%', '88.5% (18,895/21,350', '93.4%']) {
    assert.ok(history.includes(needle), `archive lost "${needle}"`);
  }
});

test('L1: the front page stays a landing page, not the log', () => {
  const lines = readme.split('\n').length;
  assert.ok(lines <= 200,
    `README.md is ${lines} lines — the qualification log has crept back onto the front page (budget: 200)`);
  assert.ok(history.split('\n').length >= 2000,
    `docs/measured-history.md is only ${history.split('\n').length} lines — the move looks incomplete`);
});

test('L2: the archive does not silently fork the install pin', () => {
  // The archive quotes historical commands verbatim (that is the point of an
  // archive), but the LIVE pin must stay unique in README.md — the journey
  // tests read README.md, not docs/. If someone regenerates the README from
  // the archive, the pin check in test/base58-journey.test.mjs catches it;
  // this leg catches the mirror mistake: a SECOND distinct tag creeping into
  // the live page.
  const tags = [...new Set((readme.match(/github:auroraxo\/sememe#(v[\d.]+\.[\d.]+[-\w.]*)/g) || [])
    .map((s) => s.split('#')[1]))];
  assert.equal(tags.length, 1, `README.md must pin exactly one tag, found: ${tags.join(', ')}`);
});
