// Pin: test/published-pin-user-zero.test.mjs
//
// The card's standing next step 3 is "user-zero am PUBLISHED Pin je Puls" —
// a stranger's first run against the version the channels actually serve.
// Until now that run existed only as a hand-run script whose artifact was
// written by hand: nothing committed PRODUCED it, so the numbers could
// drift between pulses with no gate noticing, and a pulse that forgot to
// re-run it left the last artifact standing as if it were fresh.
//
// tools/measure-published-pin-user-zero.mjs is the repeatable half, and this
// pin is the gate on its artifact.
//
// WHAT THE PIN HOLDS (each face turns the test red):
//
//   D1 the artifact names the tool that produced it, and the tool exists
//   D2 every check in the artifact PASSED — a user-zero with a failed check
//      is a measurement of a broken channel, not a clean run
//   D3 the artifact's pin equals the tag the README pins TODAY. A user-zero
//      measured against a version the README no longer names is history,
//      not a gate: the pin moves with the README, so the artifact must
//      move with it too.
//   D4 the artifact carries no host path (a scratch directory on THIS
//      machine is not reproducible evidence) and names the honest limits
//   D5 the README's own install pin resolves to exactly ONE tag (the tool
//      refuses to guess; a second pin would make the measured version
//      ambiguous)
//   G1 the tool's own source still carries the guards it claims: it must
//      install from the REGISTRY (not from this checkout), and it must
//      refuse to write a clean artifact when a check failed
//
// The live re-run is NOT part of this pin (it needs the npm registry and
// minutes of wall clock). The pin holds the committed artifact and the
// tool's shape; the pulse that produced the artifact is the one that ran
// it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACT = 'published-pin-user-zero-2026-11-19.json'; // the 2026-11-18 re-measure (pin v0.4.38 after the v0.4.38 publish); the 2026-11-16 record (0.4.30) stays as history
const TOOL = 'tools/measure-published-pin-user-zero.mjs';

const artifact = JSON.parse(readFileSync(path.join(ROOT, 'research', ARTIFACT), 'utf8'));
const toolSource = readFileSync(path.join(ROOT, TOOL), 'utf8');

test('D1: the artifact names the tool that produced it, and that tool exists', () => {
  assert.equal(artifact.tool, TOOL);
  assert.ok(existsSync(path.join(ROOT, TOOL)), 'the tool must exist in the tree');
});

test('D2: every check in the user-zero PASSED', () => {
  assert.ok(Array.isArray(artifact.checks) && artifact.checks.length >= 5,
    `the artifact must carry the checks, found ${artifact.checks?.length}`);
  for (const check of artifact.checks) {
    assert.equal(check.pass, true, `check "${check.name}" did not pass: ${check.detail}`);
    assert.ok(typeof check.detail === 'string' && check.detail.length > 0,
      `check "${check.name}" must name what it measured`);
  }
});

test('D3: the measured pin is the tag the README pins today', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const pins = [...new Set([...readme.matchAll(/github:auroraxo\/sememe#(v[\d.]+\.[\d.]+[-\w.]*)/g)]
    .map((m) => m[1]))];
  assert.equal(pins.length, 1, `README must pin exactly one tag, found: ${pins.join(', ') || 'none'}`);
  assert.equal(artifact.pin, pins[0],
    `the user-zero measured ${artifact.pin}, the README pins ${pins[0]} — re-run the tool against the current pin`);
});

test('D4: the artifact is host-free and carries its honest limits', () => {
  const serialized = JSON.stringify(artifact);
  assert.ok(!/\/tmp\/|\/home\/[a-z]+\//.test(serialized),
    'the artifact must not carry a host path');
  assert.ok(Array.isArray(artifact.limits) && artifact.limits.length >= 2,
    'the artifact must carry its limits');
  const limits = artifact.limits.join(' | ');
  assert.match(limits, /not a foreign user|zero external users/,
    'the artifact must say that this is my own user-zero, not a foreign user');
});

test('D5: the README pins exactly one install tag', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const pins = [...new Set([...readme.matchAll(/github:auroraxo\/sememe#(v[\d.]+\.[\d.]+[-\w.]*)/g)]
    .map((m) => m[1]))];
  assert.equal(pins.length, 1);
});

test('G1: the tool installs from the REGISTRY and refuses a failed artifact', () => {
  // The registry channel, not this checkout: a user-zero that measured the
  // working tree would prove nothing about what a stranger receives.
  assert.match(toolSource, /npm',?\s*\n?\s*\['install', `sememe@\$\{PIN_VERSION\}`/,
    'the tool must install sememe@<pin> from the registry');
  // The probe must run against the INSTALLED copy, not this checkout.
  assert.match(toolSource, /symlinkSync\(path\.join\(installed, 'src'\)/,
    'the probe must be retargeted at the installed copy');
  // A failed check must not be written as a clean run.
  assert.match(toolSource, /checks\.some\(\(c\) => !c\.pass\)\) process\.exit\(3\)/,
    'the tool must exit non-zero when a check failed');
  // And a registry failure must be a NO VERDICT, never a clean measurement.
  assert.match(toolSource, /no-verdict/,
    'an unreachable registry must be recorded as no-verdict, not as a clean run');
});
