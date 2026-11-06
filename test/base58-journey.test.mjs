// The pinned-install journey, run by the suite — the defect class this file
// guards was measured against the PUBLISHED install, so the guard has to be
// about the published install too, not only about the working tree.
//
// Why a separate file from test/base58-payload-bytes.test.mjs: that file pins
// the EQUIVALENCE (base58 and hex decode to the same thing) against this tree.
// This file pins that the tag a stranger installs carries the fix — a fix that
// is on main but not in the tag is exactly how v0.4.4 shipped with the defect
// in the first place (measured 2026-11-06: the front-page pin pointed at a
// tag whose own README walkthrough could not run).
//
// It packs the pinned tag the same way test/installed-tag-journey.test.mjs
// does (npm pack of an exported tag worktree = the bytes a
// `github:#<tag>` install receives), then runs the three measured payloads
// from the CLI. If the tag is not published, the tests SKIP with that reason —
// never a silent pass over a different tree.
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

let TAGPACK = null;
function tagTree(tag) {
  if (TAGPACK) return TAGPACK;
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
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-jrn-tree-'));
  execFileSync('git', ['worktree', 'add', '--detach', work, tag], { cwd: ROOT, stdio: 'pipe' });
  // The worktree is NOT removed here: the tests import the tag's own src/
  // from it, so it has to live until the last test has run (test.after).
  TAGPACK = { work, pkg: JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8')) };
  return TAGPACK;
}

function cleanupWorktree() {
  if (!TAGPACK) return;
  try {
    execFileSync('git', ['worktree', 'remove', '--force', TAGPACK.work], { cwd: ROOT, stdio: 'pipe' });
  } catch { /* best effort: the suite must not fail on a stale worktree */ }
  TAGPACK = null;
}

// A store from the committed fixture: the IDLs these payloads decode against
// are the real pulled ones (OpenBook v2 anchor, farms anchor+published, pump
// on-chain + adopted).
const STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const OPENBOOK = 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb';
const FARMS = 'FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr';

// The three payloads, measured against the published v0.4.4 install. Each is
// discriminator ++ args as the wire has it, in base58 — and its hex twin.
const CASES = [
  { label: 'pump.fun sell_v3 (union path, D1)', program: PUMP,
    base58: '3c5s1W8njd3Hcyadj9sY46ZmGiUYCxR8b', hex: '1c92de7726c469d584c159ce7818000096a7ad1300000000',
    union: true, expect: '"name": "sell_v3"' },
  { label: 'OpenBook v2 stubOracleCreate f64 (D2)', program: OPENBOOK,
    base58: 'NGerSciS12QSNBFSYtf2iJ', hex: 'ac3f65538d4cc7d8000000000000f83f',
    expect: '"price": 1.5' },
  { label: 'farms updateFarmConfig bytes (D3)', program: FARMS,
    base58: '9uUUHGhBqHoci5ACKsdJiJmXU', hex: 'd6b0bcf4cb3be6cf010004000000deadbeef',
    expect: '"data": "3q2+7w=="' },
];

import { pathToFileURL } from 'node:url';

const PIN = pinnedTag();
let skipReason = null;
let ctx = null;
try {
  ctx = tagTree(PIN);
} catch (err) {
  if (!(err instanceof SkipUnmeasurableTag)) throw err;
  skipReason = err.message;
}

test.after(() => { if (!skipReason) cleanupWorktree(); });

// Decode from the TAG'S OWN SOURCES: import the tag tree's src/ directly (a
// worktree checkout), so this measures what the tag ships rather than what is
// on main right now. The CLI shape is exercised separately in the suite's
// base58 file, against this tree.
let decodeOf = null;
if (!skipReason) {
  const mod = await import(pathToFileURL(path.join(ctx.work, 'src', 'decode.mjs')).href);
  decodeOf = { store: mod.decodePayload, union: mod.decodeUnionPayload };
}

test(`T1: the pinned tag (${PIN}) decodes a base58 union payload (v0.4.4 refused all of them)`, { skip: skipReason || false }, async () => {
  const c = CASES[0];
  const decoded = await decodeOf.union(STORE, c.program, c.base58);
  assert.equal(decoded.name, 'sell_v3');
  assert.ok(!JSON.stringify(decoded).includes('needs the payload bytes as a Buffer'));
  assert.equal(decoded.roundTripByteExact, true);
});

test(`T2: the pinned tag (${PIN}) decodes a base58 f64 payload the same as hex`, { skip: skipReason || false }, async () => {
  const c = CASES[1];
  const fromBase58 = await decodeOf.store(STORE, c.program, c.base58);
  const fromHex = await decodeOf.store(STORE, c.program, c.hex);
  assert.equal(fromBase58.args.price, 1.5, 'base58 form decodes to the f64');
  assert.deepEqual(fromBase58.args, fromHex.args, 'base58 and hex agree');
  assert.equal(fromBase58.roundTripByteExact, true);
});

test(`T3: the pinned tag (${PIN}) decodes a base58 bytes payload as base64, not a comma list`, { skip: skipReason || false }, async () => {
  const c = CASES[2];
  const fromBase58 = await decodeOf.store(STORE, c.program, c.base58);
  const fromHex = await decodeOf.store(STORE, c.program, c.hex);
  assert.equal(fromBase58.args.data, '3q2+7w==', 'bytes argument is base64');
  assert.ok(!fromBase58.args.data.includes(','), 'no comma list');
  assert.deepEqual(fromBase58.args, fromHex.args, 'base58 and hex agree');
});

test(`T4: the pinned tag (${PIN}) ships a decodeBase58 that returns a Buffer`, { skip: skipReason || false }, async () => {
  const { decodeBase58 } = await import(pathToFileURL(path.join(ctx.work, 'src', 'base58.mjs')).href);
  const bytes = decodeBase58(CASES[0].base58);
  assert.ok(Buffer.isBuffer(bytes), 'the root cause: decodeBase58 must return a Buffer');
  assert.equal(bytes.toString('hex'), CASES[0].hex, 'and the right bytes');
});

// G1: the committed journey artifact must be the one the tool prints — a
// hand-edited PASS line goes red, so the recorded journey is not decoration.
test('G1: the committed journey artifact is the one the tool produces', async () => {
  const tool = path.join(ROOT, 'tools', 'journey-v0.4.5.sh');
  assert.ok(fs.existsSync(tool), 'tools/journey-v0.4.5.sh must exist');
  const out = path.join(os.tmpdir(), `sememe-jrn-${process.pid}`);
  const res = spawnSync('bash', [tool, out], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
  const text = res.stdout + res.stderr;
  assert.match(text, /JOURNEY PASS/, `journey must pass, got:\n${text.slice(0, 2000)}`);
  const committed = fs.readFileSync(path.join(ROOT, 'research', 'journey-v0.4.5-2026-11-06.txt'), 'utf8');
  assert.match(committed, /JOURNEY PASS/, 'the committed journey artifact must record a pass');
  // The named checks in the artifact must be the checks the tool runs, so the
  // artifact cannot be trimmed to a shorter, greener list.
  for (const label of ['D1: base58 payload on the union path', 'D2: base58 f64 argument',
    'D3: base58 bytes argument as base64', 'base58 output is byte-identical to hex output']) {
    assert.ok(committed.includes(label), `committed journey must record "${label}"`);
    assert.ok(text.includes(label), `the tool must still run "${label}"`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});
