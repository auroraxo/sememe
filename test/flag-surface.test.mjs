// Flag surface tests: verify that the CLI strictly validates its arguments
// and flags, refusing unknown flags and surplus positionals with a named repair.
//
// LADDER:
//   Against the pre-fix tree (commit 641b895), tests T1–T9 FAIL because
//   the pre-fix CLI silently ignored unknown flags, dropped extra positionals,
//   and misrouted flags in positional slots.
//   Guards G1–G7 PASS on both pre-fix and post-fix trees.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMMAND_SPECS,
  COMMAND_NAMES,
  editDistance,
  closestFlag,
  unknownFlagMessage,
  parseCommandArgs,
  UsageError,
} from '../src/cli-surface.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');
const FIXTURE_STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04');
const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const WHIRL_PAYLOAD = '2b04ed0b1ac91e62a40d0100000000000100000000000000af331ba8327fbb35b1c4feff00000000010001010000000601';

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// -----------------------------------------------------------------------------
// Pure derive tests
// -----------------------------------------------------------------------------

test('U1: editDistance computes correct distances', () => {
  assert.equal(editDistance('', ''), 0);
  assert.equal(editDistance('store', 'store'), 0);
  // 'stro' -> 'store': insert 'e' + move 'r' — two edits, not one.
  assert.equal(editDistance('stro', 'store'), 2);
  assert.equal(editDistance('--store', '--stor'), 1);
  assert.equal(editDistance('--mode', '--mod'), 1);
});

test('U2: closestFlag suggests plausible typo, not unrelated flags', () => {
  const supported = ['--store', '--trailing', '--absent', '--union'];
  assert.equal(closestFlag('--stor', supported), '--store');
  assert.equal(closestFlag('--stro', supported), '--store');
  assert.equal(closestFlag('--trailin', supported), '--trailing');
  assert.equal(closestFlag('--xyz-unrelated', supported), null);
});

test('U3: unknownFlagMessage includes suggestion and supported flags list', () => {
  const msg = unknownFlagMessage('decode', '--stro', ['--store', '--trailing']);
  assert.match(msg, /unknown flag "--stro"/);
  assert.match(msg, /did you mean "--store"/);
  assert.match(msg, /supported flags: --store, --trailing/);
});

test('U4: parseCommandArgs throws UsageError on unknown flag', () => {
  assert.throws(
    () => parseCommandArgs('lock', ['--store', '/tmp', '--o', 'out.lock']),
    (err) => err instanceof UsageError && /unknown flag "--o"/.test(err.message),
  );
});

test('U5: parseCommandArgs throws UsageError on missing value', () => {
  assert.throws(
    () => parseCommandArgs('lock', ['--store']),
    (err) => err instanceof UsageError && /missing value for --store/.test(err.message),
  );
});

test('U6: parseCommandArgs enforces max positionals', () => {
  assert.throws(
    () => parseCommandArgs('lock', ['progId', '--store', '/tmp']),
    (err) => err instanceof UsageError && /lock takes no program id/.test(err.message),
  );
  assert.throws(
    () => parseCommandArgs('decode', ['progId', 'payload', 'extra', '--store', '/tmp']),
    (err) => err instanceof UsageError && /sememe decode takes 2 positional/.test(err.message),
  );
});

test('U7: parseCommandArgs refuses a flag given twice', () => {
  // The FIRST value wins in the old parser and the second is dropped
  // silently, so a caller who wrote --store A --store B believes B is in
  // effect while A is what is read. That is the same class as a typo: a
  // silent change of WHAT gets read.
  assert.throws(
    () => parseCommandArgs('lock', ['--store', '/tmp/a', '--store', '/tmp/b']),
    (err) => err instanceof UsageError && /given more than once/.test(err.message),
  );
});

test('U8: parseCommandArgs refuses a missing flag value', () => {
  assert.throws(
    () => parseCommandArgs('lock', ['--store']),
    (err) => err instanceof UsageError && /missing value for --store/.test(err.message),
  );
  // A flag value may not be another flag: `--store --out x` would otherwise
  // make the store path the literal string "--out".
  assert.throws(
    () => parseCommandArgs('lock', ['--store', '--out', 'x']),
    (err) => err instanceof UsageError && /missing value for --store/.test(err.message),
  );
});

test('U9: the supported flag list is printed EXACTLY ONCE per refusal', () => {
  // Measured on the published v0.4.7 install (2026-11-07): the first
  // version printed the list twice in one line — once in the "this command
  // accepts: ..." clause and once after "supported flags: ...". A duplicated
  // list is noise in the one message a caller reads, and a test that only
  // greps for the list cannot see it.
  const msg = unknownFlagMessage('decode', '--rpc', ['--store', '--trailing', '--absent', '--union']);
  const occurrences = msg.split('--store, --trailing, --absent, --union').length - 1;
  assert.equal(occurrences, 1, `the flag list must appear once, saw ${occurrences}: ${msg}`);
  // and the same for the suggestion branch
  const suggested = unknownFlagMessage('decode', '--stro', ['--store', '--trailing']);
  const suggestedOccurrences = suggested.split('--store, --trailing').length - 1;
  assert.equal(suggestedOccurrences, 1, `the flag list must appear once, saw ${suggestedOccurrences}: ${suggested}`);
  // a command with no flags at all says so, without an empty list
  const none = unknownFlagMessage('native-provenance', '--store', []);
  assert.match(none, /accepts no flags/);
  assert.doesNotMatch(none, /supported flags:/);
});

// -----------------------------------------------------------------------------
// Defect tests (T1-T9): must fail on pre-fix tree
// -----------------------------------------------------------------------------

test('T1: sememe lock refuses unknown flag --o with repair', () => {
  const res = runCli(['lock', '--store', FIXTURE_STORE, '--o', '/tmp/out.lock']);
  assert.notEqual(res.status, 0, 'must exit non-zero on unknown flag');
  const out = res.stdout + res.stderr;
  assert.match(out, /unknown flag "--o"/);
  assert.match(out, /did you mean "--out"/);
  assert.match(out, /--store, --out/);
});

test('T2: sememe verify refuses unknown flag --mod with repair', () => {
  const res = runCli(['verify', '--store', FIXTURE_STORE, '--mod', 'warn']);
  assert.notEqual(res.status, 0, 'must exit non-zero on unknown flag');
  const out = res.stdout + res.stderr;
  assert.match(out, /unknown flag "--mod"/);
  assert.match(out, /did you mean "--mode"/);
});

test('T3: sememe decode refuses unknown flag --stro', () => {
  const res = runCli(['decode', WHIRLPOOL, WHIRL_PAYLOAD, '--stro', FIXTURE_STORE]);
  assert.notEqual(res.status, 0, 'must exit non-zero on unknown flag');
  const out = res.stdout + res.stderr;
  assert.match(out, /unknown flag "--stro"/);
  assert.match(out, /did you mean "--store"/);
});

test('T4: sememe decode accepts flags before positional arguments', () => {
  // Before fix: `--store` placed before `<program>` was consumed into `program`,
  // corrupting the positional parser.
  const res = runCli(['decode', '--store', FIXTURE_STORE, WHIRLPOOL, WHIRL_PAYLOAD]);
  assert.equal(res.status, 0, `must decode when flag is first: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.name, 'swap_v2');
});

test('T5: sememe decode refuses extra positional arguments', () => {
  const res = runCli(['decode', WHIRLPOOL, WHIRL_PAYLOAD, 'extra-arg', '--store', FIXTURE_STORE]);
  assert.notEqual(res.status, 0, 'must exit non-zero on extra positional');
  const out = res.stdout + res.stderr;
  assert.match(out, /takes 2 positional arguments/);
  assert.match(out, /"extra-arg"/);
});

test('T6: sememe native-provenance refuses unknown flags', () => {
  const res = runCli(['native-provenance', '--store', FIXTURE_STORE]);
  assert.notEqual(res.status, 0, 'must exit non-zero on unknown flag for command with no flags');
  const out = res.stdout + res.stderr;
  assert.match(out, /unknown flag "--store"/);
});

test('T7: sememe pull refuses unknown flag --stor', () => {
  const res = runCli(['pull', '11111111111111111111111111111111', '--stor', '/tmp/store']);
  assert.notEqual(res.status, 0, 'must exit non-zero on unknown flag');
  const out = res.stdout + res.stderr;
  assert.match(out, /unknown flag "--stor"/);
  assert.match(out, /did you mean "--store"/);
});

test('T8: sememe decode refuses flag belonging to another command (--rpc)', () => {
  const res = runCli(['decode', WHIRLPOOL, WHIRL_PAYLOAD, '--store', FIXTURE_STORE, '--rpc', 'https://example.invalid']);
  assert.notEqual(res.status, 0, 'must exit non-zero on flag of another command');
  const out = res.stdout + res.stderr;
  assert.match(out, /unknown flag "--rpc"/);
});

test('T9: sememe decode refuses --absent-help as an option (it is a subcommand)', () => {
  const res = runCli(['decode', WHIRLPOOL, WHIRL_PAYLOAD, '--store', FIXTURE_STORE, '--absent-help']);
  assert.notEqual(res.status, 0, 'must exit non-zero');
  const out = res.stdout + res.stderr;
  assert.match(out, /unknown flag "--absent-help"/);
});

test('T10: sememe decode refuses a repeated --store (the first would silently win)', () => {
  const res = runCli(['decode', WHIRLPOOL, WHIRL_PAYLOAD, '--store', FIXTURE_STORE, '--store', '/tmp/other']);
  assert.notEqual(res.status, 0, 'must exit non-zero on a repeated flag');
  const out = res.stdout + res.stderr;
  assert.match(out, /given more than once/);
});

test('T11: sememe lock refuses a flag with no value', () => {
  const res = runCli(['lock', '--store']);
  assert.notEqual(res.status, 0, 'must exit non-zero on a missing flag value');
  const out = res.stdout + res.stderr;
  assert.match(out, /missing value for --store/);
});

test('T12: the CLI usage text documents the strict surface and the refusal shape', () => {
  // The refusal is only discoverable if the usage text says it exists. The
  // usage string is what `sememe` with no command (and every unknown
  // command) prints, so this is the one place a caller learns the rule.
  const usage = fs.readFileSync(BIN, 'utf8').match(/const usage = `([\s\S]*?)`;/)[1];
  assert.match(usage, /unknown flag/, 'the usage must mention that unknown flags are refused');
  assert.match(usage, /did you mean/, 'the usage must show the repair the refusal names');
  assert.match(usage, /given more than once|twice/, 'the usage must mention the repeated-flag refusal');
});

test('T13: sememe lock refuses a repeated --store', () => {
  const res = runCli(['lock', '--store', FIXTURE_STORE, '--store', '/tmp/other']);
  assert.notEqual(res.status, 0, 'must exit non-zero on a repeated flag');
  const out = res.stdout + res.stderr;
  assert.match(out, /given more than once/);
});

// -----------------------------------------------------------------------------
// Guard tests (G1-G7): must pass on BOTH pre-fix and post-fix trees
// -----------------------------------------------------------------------------

test('G1 GUARD: decode with valid flags and arguments decodes byte-exactly', () => {
  const res = runCli(['decode', WHIRLPOOL, WHIRL_PAYLOAD, '--store', FIXTURE_STORE]);
  assert.equal(res.status, 0, `must exit 0: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.name, 'swap_v2');
  assert.equal(parsed.roundTripByteExact, true);
});

test('G2 GUARD: decode --union works when flags are interleaved', () => {
  const pumpPayload = '3c5s1W8njd3Hcyadj9sY46ZmGiUYCxR8b';
  const pumpProg = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  const res = runCli(['decode', '--union', pumpProg, pumpPayload, '--store', FIXTURE_STORE]);
  assert.equal(res.status, 0, `must exit 0: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.name, 'sell_v3');
});

test('G3 GUARD: lock and verify run with valid flags', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-guard-lock-'));
  try {
    const lockOut = path.join(work, 'test.lock');
    const lockRes = runCli(['lock', '--store', FIXTURE_STORE, '--out', lockOut]);
    assert.equal(lockRes.status, 0, `lock must exit 0: ${lockRes.stderr}`);
    assert.ok(fs.existsSync(lockOut), 'lock file must be created');

    const verifyRes = runCli(['verify', '--store', FIXTURE_STORE, '--lock', lockOut, '--mode', 'warn']);
    assert.equal(verifyRes.status, 0, `verify must exit 0: ${verifyRes.stderr}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('G4 GUARD: unknown command dumps usage and exits 2', () => {
  const res = runCli(['totally-unknown-command']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage:/);
});

test('G5 GUARD: absent-help runs without arguments', () => {
  const res = runCli(['absent-help']);
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.ok(Array.isArray(parsed.forms));
});

test('G6 GUARD: pull without arguments refuses with missing program id', () => {
  const res = runCli(['pull']);
  assert.notEqual(res.status, 0);
  assert.match(res.stdout + res.stderr, /pull needs a program id/);
});

test('G7 GUARD: native-provenance with optional positional program id works', () => {
  const res = runCli(['native-provenance', '11111111111111111111111111111111']);
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.label, 'System Program');
});
