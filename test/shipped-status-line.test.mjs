// Pin: test/shipped-status-line.test.mjs
//
// The defect this pins (measured 2026-11-19, this host, main 36a1905): the
// npm tarball of sememe@0.4.38 — the bytes a stranger downloads — opens its
// README with "Status: v0.4.37" while its install pins and package.json say
// 0.4.38. The first sentence a stranger reads on the package page names a
// release this package is not.
//
// WHY NO GATE CAUGHT IT: the one-pin gate (tools/gate-shipped-readme-pin.mjs)
// counts `github:auroraxo/sememe#vX` occurrences. The Status line is prose,
// not a pin. Every release commit bumped package.json and the pins; the
// Status line was the only version mention on the landing page nobody
// bumped. Measured across ALL published releases
// (research/shipped-status-line-2026-11-19.json): 0.4.25 … 0.4.37 each named
// their own version (13 clean), the four earliest releases carry no Status
// line (the front page did not exist before 2026-11-13), and 0.4.38 is the
// FIRST and only stale one.
//
// WHAT THE PIN HOLDS (each face turns the test red):
//
//   D-tree THIS tree's own packed tarball ships a Status line equal to
//        `v<package.json version>` — the fix is real, not only named. This
//        face is RED on the pre-fix tree (36a1905: README v0.4.37, package
//        0.4.38) and is the red-first proof.
//   G-wire  the gate's source actually WIRES the Status judgement into its
//        refusal path (calls judgeStatus with the shipped README, and its
//        problem text names R5 in the exact sentence the product's own
//        channel prints). A mention in a comment without the call, or a
//        softened sentence, would be a weakened gate. RED on the pre-fix
//        tree.
//   G-agree the gate's EXPORTED judge agrees with the rule as written here,
//        on all three sample classes (match / stale / missing). Two
//        judgements must not be two answers. RED on the pre-fix tree (the
//        export did not exist).
//   D-hist  the committed artifact records the DEFECTIVE verdict with counts
//        that agree with its own rows, names 0.4.38 as stale naming v0.4.37,
//        and records 0.4.37 as clean — the immutable history.
//   G-rule  the rule itself, as a pure function INSIDE this test (not
//        imported from the implementation, so a weakened implementation
//        cannot weaken its own pin): a matching Status passes, a stale one
//        and a missing one are refused.
//   G-prep  package.json still wires `prepublishOnly` to the gate — the
//        refusal stands in front of the publish.
//   D-clean the artifact leaks no host path and states its limits.
//
// The live registry re-run is NOT part of this pin (it needs the npm
// registry); the artifact holds the defect record, the post-release
// re-measurement lands in its own dated artifact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACT = path.join(ROOT, 'research', 'shipped-status-line-2026-11-19.json');
const TOOL = path.join(ROOT, 'tools', 'measure-shipped-status-line.mjs');
const GATE = path.join(ROOT, 'tools', 'gate-shipped-readme-pin.mjs');

const artifact = existsSync(ARTIFACT) ? JSON.parse(readFileSync(ARTIFACT, 'utf8')) : null;
const gateSource = existsSync(GATE) ? readFileSync(GATE, 'utf8') : null;

// The rule, written HERE so the pin does not depend on the implementation it
// pins. Same extraction the gate performs: first line carrying `Status:`,
// then the version token.
function statusLineOf(readme) {
  const line = String(readme).split('\n').find((l) => l.includes('Status:'));
  if (!line) return null;
  const match = /Status:\s*(v[0-9]+\.[0-9]+\.[0-9]+(?:[-\w.]*)?)/.exec(line);
  return match ? match[1] : null;
}

function packThisTree() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'sememe-status-pin-'));
  try {
    const packed = spawnSync('npm', ['pack', '--pack-destination', scratch, '--json', '--ignore-scripts'],
      { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
    if (packed.status !== 0) return { error: 'npm pack failed' };
    let files = null;
    try { files = JSON.parse(packed.stdout); } catch { files = null; }
    const tarball = Array.isArray(files) && files[0] && files[0].filename
      ? path.join(scratch, files[0].filename)
      : readdirSync(scratch).filter((f) => f.endsWith('.tgz'))[0];
    if (!tarball) return { error: 'no tarball' };
    const readme = spawnSync('tar', ['-xOf', tarball, 'package/README.md'], { encoding: 'utf8', timeout: 60000 });
    const pkg = spawnSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8', timeout: 60000 });
    if (readme.status !== 0 || pkg.status !== 0) return { error: 'tar extraction failed' };
    return { readme: readme.stdout, version: JSON.parse(pkg.stdout).version };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('D-tree: THIS tree ships a Status line naming its own version', () => {
  const packed = packThisTree();
  assert.ok(!packed.error, `this tree could not be packed: ${packed.error}`);
  const status = statusLineOf(packed.readme);
  assert.ok(status, `the shipped README carries no Status line at all (package ${packed.version})`);
  assert.equal(
    status, `v${packed.version}`,
    `the shipped README's Status line says ${status} but package.json says ${packed.version} — the first sentence a stranger reads names a release this package is not`,
  );
});

test('G-wire: the gate WIRES the Status judgement into its refusal path', () => {
  assert.ok(gateSource, 'the publishing gate is missing');
  assert.ok(gateSource.includes('function judgeStatus'), 'the gate no longer defines the Status judgement');
  assert.ok(gateSource.includes("judgeStatus({ readme: extract.stdout"), 'the gate defines the Status judgement but never CALLS it on the shipped README — a softened gate');
  // The exact sentence the channel prints: pinned so a mutation that only
  // changes the COMMENT cannot pass this face (the ladder's M8).
  assert.ok(gateSource.includes("R5 the shipped README's Status line says"), 'the gate\u2019s Status refusal sentence was rewritten — the operator\u2019s channel no longer says what the product says');
  assert.ok(gateSource.includes('export function statusOf'), 'the gate no longer exports the Status extraction (the measurement imports it)');
});

test('G-agree: the gate\u2019s exported judge agrees with this pin\u2019s rule', async () => {
  const gate = await import(GATE);
  assert.equal(typeof gate.judgeStatus, 'function', 'the gate does not export judgeStatus');
  const version = '9.9.9';
  const matching = gate.judgeStatus({ readme: `intro\n**Status: v9.9.9 — shipped.**\n`, version });
  assert.equal(matching.ok, true, 'the gate refuses a Status line that names the shipped version');
  const stale = gate.judgeStatus({ readme: `intro\n**Status: v9.9.8 — shipped.**\n`, version });
  assert.equal(stale.ok, false, 'the gate passes a Status line naming a DIFFERENT version');
  assert.ok(stale.problems[0].includes('R5'), 'the stale refusal does not name R5');
  const missing = gate.judgeStatus({ readme: 'no status line here\n', version });
  assert.equal(missing.ok, false, 'the gate passes a README without any Status line');
  // The extraction both sides perform agrees token for token.
  assert.equal(gate.statusOf('a\nStatus: v1.2.3 — x'), statusLineOf('a\nStatus: v1.2.3 — x'));
});

test('D-hist: the artifact records the DEFECT with counts that agree with its rows', () => {
  assert.ok(artifact, 'the measurement artifact is missing');
  assert.equal(artifact.tool, 'tools/measure-shipped-status-line.mjs');
  assert.ok(existsSync(TOOL), 'the measuring tool is missing');
  assert.equal(artifact.verdict, 'shipped-status-line-stale', 'the artifact claims a clean channel — the defect record was rewritten');
  const rows = artifact.versions;
  const stale = rows.filter((r) => r.verdict === 'stale-status');
  const clean = rows.filter((r) => r.verdict === 'clean');
  const noStatus = rows.filter((r) => r.verdict === 'no-status');
  assert.equal(artifact.counts.measured, rows.filter((r) => r.verdict !== 'no-verdict').length, 'counts.measured must match the rows');
  assert.equal(artifact.counts.staleStatus, stale.length, 'the stale count must match the rows');
  assert.equal(artifact.counts.clean, clean.length, 'the clean count must match the rows');
  assert.equal(artifact.counts.noStatus, noStatus.length, 'the no-status count must match the rows');
  // The named history: 0.4.38 was npm `latest` when the defect was found and
  // is immutable — this face must hold for every future release.
  const found = rows.find((r) => r.version === '0.4.38');
  assert.ok(found, 'the artifact does not measure 0.4.38');
  assert.equal(found.verdict, 'stale-status', '0.4.38 must be recorded as carrying a stale Status line');
  assert.equal(found.statusVersion, 'v0.4.37', 'the artifact must name the version the stale line advertises');
  assert.equal(found.shippedVersion, '0.4.38', 'the artifact must record the version the package actually is');
  // 0.4.37 named its OWN version — the line was right one release earlier,
  // so this is one missed bump, not a rule misfiring. (This face holds on the
  // PRE-FIX tree where the artifact was measured; after the fix the tree
  // ships v0.4.39 and 0.4.38 becomes the newest clean line.)
  const previous = rows.find((r) => r.version === '0.4.37');
  assert.ok(previous, 'the artifact does not measure 0.4.37');
  assert.equal(previous.verdict, 'clean', '0.4.37 must be recorded as naming its own version');
  // And the tool's own tree measurement recorded the same defect.
  assert.equal(artifact.thisTree.verdict, 'stale-status', 'the artifact must record that the producing tree itself shipped the stale line');
  assert.equal(artifact.thisTree.statusVersion, 'v0.4.37');
});

test('G-rule: the rule as a pure function (stale and missing are refused, matching passes)', () => {
  const judge = (readme, version) => {
    const status = statusLineOf(readme);
    return status !== null && status === `v${version}`;
  };
  assert.equal(judge('intro\n**Status: v1.0.0 — shipped.**\n', '1.0.0'), true);
  assert.equal(judge('intro\n**Status: v1.0.0 — shipped.**\n', '1.0.1'), false);
  assert.equal(judge('no status line\n', '1.0.0'), false);
  assert.equal(judge('intro\nStatus: not a version\n', '1.0.0'), false);
});

test('G-prep: package.json still wires prepublishOnly to the gate', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.prepublishOnly, 'node tools/gate-shipped-readme-pin.mjs',
    'the publish-time refusal is no longer wired — a stale landing page could ship again');
});

test('D-clean: the artifact leaks no host path and states its limits', () => {
  assert.ok(artifact, 'the measurement artifact is missing');
  const text = JSON.stringify(artifact);
  assert.ok(!text.includes(os.tmpdir()), 'the artifact leaks a host temp path');
  assert.ok(!/\/home\/[a-z]/i.test(text), 'the artifact leaks a host home path');
  assert.ok(Array.isArray(artifact.limits) && artifact.limits.length >= 3, 'the artifact must carry its limits');
  assert.ok(artifact.limits.some((l) => /zero external users/i.test(l)), 'the limits must state the user-zero truth');
  assert.ok(artifact.limits.some((l) => /immutable/i.test(l)), 'the limits must state that published versions cannot be repaired');
});
