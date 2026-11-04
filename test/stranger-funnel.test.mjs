// stranger-funnel.test.mjs — the adoption FUNNEL is pinned, not the decoder.
//
// Everything else in this repository proves the decoder works. The card's
// gate is different: "an outside person runs sememe on their own data". The
// funnel is what stands between a curious stranger and that first run:
//
//   F1  a FRESH CLONE from GitHub runs the README quickstart verbatim;
//   F2  the PUBLISHED TAG installs into an EMPTY app with no npm account;
//   F3  the installed tree is the product, not the harness.
//
// The instrument (tools/measure-stranger-funnel.mjs) touches GitHub and the
// registry, so it is NOT part of the offline suite: it runs only when
// SEMEME_FUNNEL_NETWORK=1, and skips with a named reason otherwise. What IS
// always in the suite is the committed artifact (T4-T6): the funnel result
// must exist, be complete, and agree with the numbers the README quotes.
//
// Ladder (tests written FIRST):
//   T1: the instrument exists and enforces its CLI contract
//   T2: the instrument's verdict vocabulary is closed — a step is measured,
//       failed or no-verdict, never anything else
//   T3 (network, opt-in): a live run measures every funnel step
//   T4: the committed funnel artifact is complete: all steps measured
//   T5: the artifact's quickstart numbers agree with the README's quoted
//       numbers (the funnel and the README must describe the same product)
//   T6: the artifact's installed-tree check is honest: the harness is
//       absent and the product's entries are present
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACT = path.join(ROOT, 'research', 'stranger-funnel-2026-11-05.json');
const TOOL = path.join(ROOT, 'tools', 'measure-stranger-funnel.mjs');
const NETWORK = process.env.SEMEME_FUNNEL_NETWORK === '1';

test('T1: the funnel instrument exists and enforces its CLI contract', () => {
  assert.ok(existsSync(TOOL), 'tools/measure-stranger-funnel.mjs must exist');
  const source = readFileSync(TOOL, 'utf8');
  assert.match(source, /process\.exit\(report\.verdict === 'funnel-measured' \? 0 : 3\)/,
    'the instrument must exit 0 only on a measured funnel and 3 on no-verdict');
  assert.match(source, /report\.verdict = 'no-verdict'/, 'a failed step must produce no-verdict, never a partial pass');
});

test('T2: the instrument reports a closed verdict vocabulary', () => {
  const source = readFileSync(TOOL, 'utf8');
  for (const verb of ['measured', 'failed']) {
    assert.ok(source.includes(`verdict: '${verb}'`), `step verdicts must include ${verb}`);
  }
  assert.ok(!source.includes("verdict: 'pass'"), 'a step may never report a bare "pass" — the vocabulary is measured/failed');
});

test('T3: a live funnel run measures every step', { skip: NETWORK ? false : 'network measurement: set SEMEME_FUNNEL_NETWORK=1' }, () => {
  const out = path.join(ROOT, 'research', 'stranger-funnel-live.tmp.json');
  const stdout = execFileSync('node', [TOOL, '--out', out], { cwd: ROOT, encoding: 'utf8', timeout: 1_500_000 });
  const summary = JSON.parse(stdout);
  assert.equal(summary.verdict, 'funnel-measured');
  const steps = ['fresh-clone', 'readme-quickstart-commands', 'quickstart-on-fresh-clone', 'install-published-tag', 'installed-tree-is-the-product', 'decode-through-installed-entry'];
  for (const step of steps) {
    const row = summary.steps.find((s) => s.step === step);
    assert.ok(row, `the live run must report the step ${step}`);
    assert.equal(row.verdict, 'measured', `${step} must measure`);
  }
});

test('T4: the committed funnel artifact is complete: every step measured', () => {
  assert.ok(existsSync(ARTIFACT), 'research/stranger-funnel-2026-11-05.json must be committed');
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  assert.equal(artifact.verdict, 'funnel-measured');
  const steps = ['fresh-clone', 'readme-quickstart-commands', 'quickstart-on-fresh-clone', 'install-published-tag', 'installed-tree-is-the-product', 'decode-through-installed-entry'];
  for (const step of steps) {
    const row = artifact.steps.find((s) => s.step === step);
    assert.ok(row, `the artifact must carry the step ${step}`);
    assert.equal(row.verdict, 'measured', `${step} must be measured`);
  }
});

test('T5: the artifact and the README describe the same product', () => {
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const run = artifact.steps.find((s) => s.step === 'quickstart-on-fresh-clone');
  assert.ok(run.runs.length >= 2, 'the funnel must measure both quickstart commands');
  const sample = run.runs.find((r) => r.summary.programs > 1);
  assert.ok(sample, 'the multi-program quickstart run must be measured');
  const quoted = readme.match(/([\d,]+) checked transactions, ([\d,]+) payloads, ([\d,]+) decoded/);
  assert.ok(quoted, 'the README must quote the multi-program numbers');
  const clean = (s) => Number(String(s).replace(/,/g, ''));
  assert.equal(sample.summary.transactionsChecked, clean(quoted[1]));
  assert.equal(sample.summary.payloadsChecked, clean(quoted[2]));
  assert.equal(sample.summary.decoded, clean(quoted[3]));
});

test('T6: the installed tree was the product, not the harness', () => {
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  const step = artifact.steps.find((s) => s.step === 'installed-tree-is-the-product');
  assert.equal(step.harnessAbsent, true);
  for (const required of ['index.mjs', 'src', 'interface', 'vendor', 'bin']) {
    assert.ok(step.entries.includes(required), `the installed tree must carry ${required}`);
  }
  for (const forbidden of ['tools', 'test', 'research']) {
    assert.ok(!step.entries.includes(forbidden), `the harness must not travel into node_modules (${forbidden})`);
  }
});
