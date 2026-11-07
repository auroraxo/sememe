// The receipt-hygiene measurement: a file in `receipts/` that is not a
// receipt must not brick any surface — and a receipt that IS damaged must
// still be refused.
//
// This file pins the two committed artifacts of
// tools/measure-receipt-hygiene.mjs:
//
//   research/receipt-hygiene-2026-11-07-before.json  the PUBLISHED v0.4.10
//       install (github:auroraxo/sememe#v0.4.10, no clone)
//   research/receipt-hygiene-2026-11-07.json          the FIXED tree
//
// WHAT WAS MEASURED on v0.4.10 — sememe's OWN writer (src/store-write.mjs)
// installs every receipt through a temporary file `<name>.tmp-<pid>-<hex>` in
// the SAME `receipts/` directory and removes it in a `finally`. A crash
// between the write and the cleanup leaves that file behind forever, and
// every reader treated EVERY file in `receipts/` as a receipt:
//
//   sememe decode <program> <payload>   -> EXIT 1 "store receipt <tmp file>
//                                            is unreadable: Unexpected token"
//   sememe decode --union <program> ... -> EXIT 1, same refusal
//   sememe lock                         -> EXIT 1, "Cannot destructure
//                                            property 'idl' ... as it is null"
//   sememe verify --mode error          -> EXIT 1, "unverified: <program>"
//
// The last one is the worst: the CI gate went RED over an INTACT program and
// named no repair — the user is told to re-pull a healthy store. One crashed
// write permanently bricked a working store.
//
// The same root cause produced phantom programs from FOREIGN files:
// `.DS_Store` appeared as `extra` — and `my-file.json` became a phantom
// program `my` that FAILED the gate over a file that was never a receipt.
//
// The ladder in test/receipt-hygiene.test.mjs pins the BEHAVIOUR of the fix;
// this file pins the MEASUREMENT (the artifacts are what the tool produces,
// not what a human typed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-receipt-hygiene.mjs');
const BEFORE = path.join(ROOT, 'research', 'receipt-hygiene-2026-11-07-before.json');
const AFTER = path.join(ROOT, 'research', 'receipt-hygiene-2026-11-07.json');

const before = JSON.parse(await readFile(BEFORE, 'utf8'));
const after = JSON.parse(await readFile(AFTER, 'utf8'));

test('the BEFORE artifact records the defect on the PUBLISHED v0.4.10 install', () => {
  assert.equal(before.binary.tag, 'v0.4.10',
    'the before-artifact must be measured on the published tag, not on this tree');
  assert.equal(before.verdict.ok, false,
    'v0.4.10 violated the contract — if this says clean, the measurement is wrong');

  // The crash debris broke EVERY surface at once.
  assert.equal(before.cases.h1.decodeExit, 1,
    'v0.4.10 decode must have refused a store with crash debris');
  assert.equal(before.cases.h2.unionDecodeExit, 1,
    'v0.4.10 decode --union must have refused it too');
  assert.equal(before.cases.h3.lockExit, 1,
    'v0.4.10 lock must have refused it (the destructure crash)');

  // The headline: a CRASHED WRITE turned a CLEAN store RED.
  assert.equal(before.cases.h4.verifyErrorExit, 1,
    'v0.4.10 verify --mode error exited 1 over a store whose program was intact');
  assert.equal(before.cases.h4.verifyWarnViolations, 1,
    'v0.4.10 counted a violation over an intact program');

  // Nothing was reported: the debris was invisible, neither ignored nor named.
  assert.deepEqual(before.cases.h5.stray, [],
    'v0.4.10 had no way to report a stray file at all');

  // The foreign file became a PHANTOM program.
  assert.deepEqual(before.controls.h6.extra, ['.DS_Store'],
    'v0.4.10 read .DS_Store as a program in the store');
  assert.deepEqual(before.controls.h6.stray, [],
    'v0.4.10 did not know what a stray file was');
});

test('the AFTER artifact is the one the tool produces right now (no hand-edited numbers)', () => {
  const fresh = path.join(ROOT, 'research', '.receipt-hygiene-fresh.json');
  try {
    execFileSync(process.execPath, [TOOL, '--out', fresh], { cwd: ROOT, stdio: 'ignore' });
    const produced = JSON.parse(readFileSync(fresh, 'utf8'));
    assert.deepEqual(produced.verdict.violations, [],
      'the tool must find no contract violation on this tree');
    assert.equal(produced.verdict.ok, true);
    // The committed artifact must BE the tool's output, up to the timestamp.
    const strip = (r) => { const c = { ...r }; delete c.measuredAt; return c; };
    assert.deepEqual(strip(produced), strip(after),
      'the committed after-artifact is not what the tool derives — re-run the tool and commit its output');
  } finally {
    rmSync(fresh, { force: true });
  }
});

test('the AFTER artifact records the fix: every surface survives, the debris is named', () => {
  assert.equal(after.verdict.ok, true, 'this tree must meet the contract');
  assert.deepEqual(after.verdict.violations, []);

  // Every surface answers again over a store with crash debris.
  assert.equal(after.cases.h1.decodeExit, 0, 'decode must answer over crash debris');
  assert.equal(after.cases.h2.unionDecodeExit, 0, 'decode --union must answer over crash debris');
  assert.equal(after.cases.h3.lockExit, 0, 'lock must succeed over crash debris');
  assert.equal(after.cases.h3.lockFileWritten, true, 'the lock must actually be written');

  // The clean store stays clean — the fix must not have moved the gate.
  assert.equal(after.cases.h4.verifyErrorExit, 0,
    'a crashed write must not turn a clean store red');
  assert.equal(after.cases.h4.verifyWarnViolations, 0,
    'the gate must count no violation over an intact program');

  // Ignored, but NOT silently: the debris is named with its kind.
  assert.equal(after.cases.h5.stray.length, 1, 'the debris must be reported');
  assert.equal(after.cases.h5.stray[0].kind, 'debris',
    'the crash debris must be reported as debris, not as a receipt');
  assert.ok(after.cases.h5.stray[0].name.endsWith('.tmp-4711-9f2c1a'),
    'the reported name must be the debris file itself');

  // The controls: a foreign file is not a program, and damage is still damage.
  assert.deepEqual(after.controls.h6.extra, [],
    '.DS_Store must not be a program in the store');
  assert.equal(after.controls.h6.verifyErrorExit, 0);
  assert.equal(after.controls.h6.violations, 0);
  assert.deepEqual(after.controls.h6.stray, ['.DS_Store'],
    'the foreign file must still be reported');
  assert.equal(after.controls.h7.violations, 1,
    'a damaged receipt must still be a violation');
  assert.deepEqual(after.controls.h7.unverified, [after.controls.h7.unverified[0]],
    'the damaged program must be named');
  assert.ok(after.controls.h7.unverified[0].startsWith('whirLbMiic'),
    'the damaged program must be the pinned one');
});

test('neither artifact carries a host path — a committed artifact with an absolute path is a snapshot', () => {
  for (const [name, artifact] of [['before', before], ['after', after]]) {
    const serialized = JSON.stringify(artifact);
    assert.ok(!serialized.includes('/home/aurora/'),
      `the ${name}-artifact carries an absolute host path — it will not reproduce on CI`);
    assert.ok(!serialized.includes('/tmp/'),
      `the ${name}-artifact carries a scratch-directory path — it will not reproduce on CI`);
  }
  assert.equal(after.binary.path, 'bin/sememe.mjs',
    'the after-artifact must name the binary relative to the repo');
  assert.equal(before.binary.path, null,
    'a foreign install has no path inside the repo; it is named by its tag');
});
