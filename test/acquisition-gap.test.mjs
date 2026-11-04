// The acquisition gap is CLASSIFIED, not guessed: pullable vs publishes-nothing.
//
// The claim under test: of the 306 no-interface payloads in the committed
// foreign sweep, 177 sit behind programs that publish an on-chain IDL sememe
// never pulled, and 129 behind programs that publish nothing. Those two need
// opposite fixes, so a report that merges them picks the wrong work.
//
// Falsification ladder (all tests UNGUARDED, so they run against a pre-fix
// tree too — a skip guard would make the ladder look green without the fix):
//   T1 the report harness does not exist on the pre-tree -> red (exit 2 / ENOENT)
//   T2 a pullable program must be reported pullable with its source
//   T3 a program with neither address answering must be `no-interface-published`,
//      and it must NOT be told to pull (that is the opposite fix)
//   T4 an RPC failure must be `unknown` + verdict no-verdict, never folded
//      into "publishes nothing" — the crates.io-403 lesson
//   T5 a hand-edited artifact whose counts no longer sum to noInterface -> red
//   T6 GREEN ON EVERY TREE: the committed sweep artifact's own gap counts are
//      self-consistent (pure JSON, no tool involved — the false-positive guard)
//   T7 the committed gap artifact matches what the harness computes
//   T8 the shipped `sememe gap` CLI gives opposite advice to opposite cases

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CLI = path.join(ROOT, 'bin', 'sememe.mjs');
const HARNESS = path.join(ROOT, 'tools', 'acquisition-gap.mjs');
const SWEEP = path.join(ROOT, 'research', 'step-ingestooor-full-sweep-2026-11-04.json');
const GAPPATH = path.join(ROOT, 'research', 'acquisition-gap-2026-11-04.json');

const sweep = JSON.parse(await readFile(SWEEP, 'utf8'));

/** Run the CLI; returns { code, stdout, stderr } instead of throwing. */
function cli(args, script = CLI) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}

test('T6: the committed sweep artifact sums its own gap counts (false-positive guard, green on every tree)', async () => {
  const perProgram = sweep.noInterfaceByProgram;
  assert.ok(perProgram && typeof perProgram === 'object', 'the sweep report must carry per-program gap counts');
  const sum = Object.values(perProgram).reduce((total, count) => total + count, 0);
  assert.equal(sum, sweep.noInterface, 'per-program gap counts must sum to the headline noInterface');
  assert.equal(sweep.summary.noInterface, sweep.noInterface, 'summary must agree with the headline');
  assert.equal(Object.keys(perProgram).length, 70, 'measured: 70 gap programs in the 156-fixture set');
  assert.equal(sum, 306, 'measured: 306 gap payloads in the 156-fixture set');
});

test('T2: a program that publishes an on-chain IDL is `pullable`, with its source named', async () => {
  const { classify } = await import('../src/gap.mjs');
  // Jupiter DCA (DCA265...): measured live 2026-11-04, legacy anchor:idl
  // account present, 12 instructions — a never-pulled gap, not a derivation job.
  const idl = { instructions: [{ name: 'create_order', discriminator: [1, 2, 3, 4, 5, 6, 7, 8], args: [] }] };
  const anchor = { owner: 'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M',
    data: [fakeAnchorAccount(idl), 'base64'] };
  const verdict = classify('DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M', [null, anchor]);
  assert.equal(verdict.verdict, 'pullable');
  assert.equal(verdict.source, 'anchor');
  assert.equal(verdict.instructions, 1);
  assert.equal(verdict.decodableStoredOnly, true);
});

test('T3: a program with neither address answering is `no-interface-published`, and is not told to pull', async () => {
  const { classify } = await import('../src/gap.mjs');
  const program = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'; // 42 payloads, both addresses null
  const verdict = classify(program, [null, null]);
  assert.equal(verdict.verdict, 'no-interface-published', 'absence at both addresses must be its own verdict');
  assert.notEqual(verdict.verdict, 'pullable', 'the opposite fix must not be recommended for it');
  assert.equal(verdict.source, undefined);
  // An account that exists but cannot be decoded is a third verdict, never
  // folded into "publishes nothing".
  const broken = classify(program, [{ owner: 'ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S', data: ['AAAA', 'base64'] }, null]);
  assert.equal(broken.verdict, 'present-undecodable', 'an unusable interface is a different finding from an absent one');
});

test('T4: an RPC failure is `unknown` and withholds the verdict instead of reading as absence', async () => {
  const { probeGap, summarize } = await import('../src/gap.mjs');
  const failing = async () => { throw new Error('HTTP 403 rate limited'); };
  const { rows, summary } = await probeGap(
    [{ program: 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', payloads: 42 }],
    { url: 'https://mock.invalid/rpc', fetcher: failing },
  );
  assert.equal(rows[0].verdict, 'unknown', 'a transport failure must never become a claim about the chain');
  assert.notEqual(rows[0].verdict, 'no-interface-published');
  assert.equal(summary.verdict, 'no-verdict');
  assert.equal(summary.unknown, 1);
  assert.equal(summary.publishesNothingPrograms, 0, 'an unknown row must not be counted as publishes-nothing');
  assert.equal(summarize([{ program: 'x', payloads: 0, verdict: 'unknown' }]).verdict, 'no-verdict');
});

test('T5: a hand-edited gap count that no longer sums to the headline is refused', async () => {
  const { programsFromReport } = await import('../src/gap.mjs');
  const tampered = { ...sweep, noInterfaceByProgram: { ...sweep.noInterfaceByProgram, 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95': 41 } };
  assert.throws(() => programsFromReport(tampered), /sum to 305/, 'the edited count must be caught by the sum');
  const programs = programsFromReport(sweep);
  assert.equal(programs.length, 70);
  assert.equal(programs.reduce((n, p) => n + p.payloads, 0), 306);
});

test('T1: the CLI classifies the committed gap report and writes the artifact (probe against the chain)', async () => {
  // Runs for real against mainnet (this is the measurement, not a fixture);
  // a probe failure exits 3 and must not be recorded as an absence.
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sememe-gap-'));
  try {
    const out = path.join(tmp, 'gap.json');
    const { code, stdout, stderr } = await cli(['--report', SWEEP, '--out', out], HARNESS);
    assert.ok([0, 3].includes(code), `expected exit 0 (measured) or 3 (no verdict), got ${code}: ${stderr.slice(0, 300)}`);
    const artifact = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(artifact.tool, 'acquisition-gap');
    assert.equal(artifact.source.noInterface, 306, 'the report is the denominator');
    assert.equal(artifact.summary.payloads, 306, 'every gap payload must be classified exactly once');
    assert.equal(artifact.summary.programs, 70);
    if (code === 3) {
      assert.equal(artifact.summary.verdict, 'no-verdict');
      // Partial probe: unknown rows are named, and none of them may claim
      // the chain published nothing.
      for (const row of artifact.rows.filter((r) => r.verdict === 'unknown')) {
        assert.equal(row.payloads > 0, true);
      }
      return;
    }
    // Full measurement (the numbers quoted on the card, 2026-11-04):
    const s = artifact.summary;
    assert.equal(s.verdict, 'measured');
    assert.equal(s.unknown, 0, 'a measured verdict means no probe failed');
    assert.equal(s.pullablePayloads + s.publishesNothingPayloads + (s.payloadsByVerdict['present-undecodable'] ?? 0)
      + (s.payloadsByVerdict.vendored ?? 0), 306, 'verdicts must partition the gap');
    assert.equal(s.pullablePayloads, 177, 'measured 2026-11-04: 34 programs publish an IDL we never pulled');
    assert.equal(s.pullablePrograms, 34);
    assert.equal(s.publishesNothingPayloads, 129, 'measured 2026-11-04: 36 programs publish nothing');
    // The two named next-step candidates must land on opposite sides — that is
    // the finding that changes the card's plan.
    const dca = artifact.rows.find((r) => r.program === 'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M');
    assert.equal(dca?.verdict, 'pullable', 'Jupiter DCA publishes an on-chain IDL: this is a pull, not a derivation');
    const raydium = artifact.rows.find((r) => r.program === 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
    assert.equal(raydium?.verdict, 'no-interface-published', 'the 42-payload program publishes nothing');
    assert.equal(raydium.payloads, 42);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('T7: the committed artifact is self-consistent (false-positive guard: pure JSON, no tool involved)', async () => {
  const artifact = JSON.parse(await readFile(GAPPATH, 'utf8'));
  assert.equal(artifact.summary.payloads, 306, 'the artifact must account for the whole gap');
  assert.equal(artifact.summary.programs, 70);
  assert.equal(artifact.source.report, 'research/step-ingestooor-full-sweep-2026-11-04.json');
  const sum = artifact.rows.reduce((n, row) => n + row.payloads, 0);
  assert.equal(sum, 306, 'rows must sum to the headline');
  assert.equal(artifact.summary.verdict, 'measured');
  assert.equal(artifact.summary.unknown, 0);
  // Every verdict the summary claims must be present in the rows.
  const counts = {};
  for (const row of artifact.rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
  for (const [verdict, count] of Object.entries(artifact.summary.byVerdict)) {
    assert.equal(counts[verdict], count, `summary.byVerdict[${verdict}] must equal the rows`);
  }
});

test('T8: the shipped `sememe gap` CLI tells a stranger WHICH fix applies', async () => {
  // The user-facing surface: a consumer who hit "no stored IDL for program X"
  // asks why, and must not be told to pull a program that publishes nothing.
  const pullable = await cli(['gap', 'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M']);
  assert.equal(pullable.code, 0, `the gap command must answer, got: ${pullable.stderr.slice(0, 200)}`);
  const row = JSON.parse(pullable.stdout);
  assert.equal(row.verdict, 'pullable');
  assert.match(row.next, /sememe pull/, 'a pullable program must point at the pull');

  const nothing = await cli(['gap', 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95']);
  assert.equal(nothing.code, 0);
  const absent = JSON.parse(nothing.stdout);
  assert.equal(absent.verdict, 'no-interface-published');
  assert.doesNotMatch(absent.next, /sememe pull /, 'a program that publishes nothing must NOT be told to pull it');
  assert.match(absent.next, /adopt|derivation/, 'it must name the fix that can actually work');
  assert.ok(absent.addresses?.metadata && absent.addresses?.anchor, 'both probed addresses must be shown');
});

test('M1: a classifier that calls an absent interface "pullable" goes red (the wrong fix must not survive)', async () => {
  // The mutation this whole card's finding rests on: if the classifier ever
  // answered "pullable" for a program that publishes nothing, the report
  // would recommend a pull that can never succeed. The mutation is applied
  // to a COPY of the module, the real tree is untouched.
  const tmp = await mkdtemp(path.join(ROOT, '.mut-'));
  try {
    const source = await readFile(path.join(ROOT, 'src', 'gap.mjs'), 'utf8');
    const mutated = source.replace(
      "return { program, verdict: 'no-interface-published', canonical: c.state, legacy: l.state };",
      "return { program, verdict: 'pullable', source: 'anchor', canonical: c.state, legacy: l.state };",
    );
    assert.notEqual(mutated, source, 'the mutation must actually change the source');
    // The mutant lives INSIDE src/ (so its relative imports resolve against
    // the real tree, including the vendored Rust) but under a dot-prefixed
    // name, and it is deleted in the finally block. The real module is never
    // modified.
    const mutatedPath = path.join(ROOT, 'src', `.gap-mutant-${path.basename(tmp)}.mjs`);
    await writeFile(mutatedPath, mutated);
    const { classify } = await import(mutatedPath);
    const verdict = classify('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', [null, null]);
    // Non-vacuity: the mutation MUST flip the verdict the T3 guard asserts
    // on. If it did not, T3 would be a guard that pins nothing — the exact
    // defect the README-Pinning-Test incident (04.11., hardcoded fallback)
    // taught this repo.
    assert.equal(verdict.verdict, 'pullable',
      'the mutation must flip the verdict, otherwise the T3 guard pins nothing');
    // And the real module still answers the other way (the guard is not
    // vacuous against the unmutated tree either).
    const { classify: real } = await import('../src/gap.mjs');
    assert.equal(real('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', [null, null]).verdict, 'no-interface-published');
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await rm(path.join(ROOT, 'src', `.gap-mutant-${path.basename(tmp)}.mjs`), { force: true });
  }
});

test('M2: a classifier that folds an RPC failure into "publishes nothing" goes red', async () => {
  const tmp = await mkdtemp(path.join(ROOT, '.mut2-'));
  try {
    const source = await readFile(path.join(ROOT, 'src', 'gap.mjs'), 'utf8');
    const mutated = source.replace(
      "rows.push({ program, payloads, verdict: 'unknown', error: response.error });",
      "rows.push({ program, payloads, verdict: 'no-interface-published', error: response.error });",
    );
    assert.notEqual(mutated, source, 'the mutation must actually change the source');
    const mutatedPath = path.join(ROOT, 'src', `.gap-mutant-${path.basename(tmp)}.mjs`);
    await writeFile(mutatedPath, mutated);
    const { probeGap } = await import(mutatedPath);
    const failing = async () => { throw new Error('HTTP 403 rate limited'); };
    const { rows, summary } = await probeGap(
      [{ program: 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', payloads: 42 }],
      { url: 'https://mock.invalid/rpc', fetcher: failing },
    );
    // Non-vacuity: the mutation must flip BOTH assertions the T4 guard
    // makes, otherwise T4 pins nothing.
    assert.equal(rows[0].verdict, 'no-interface-published',
      'the mutation must flip the verdict, otherwise the T4 guard pins nothing');
    assert.equal(summary.verdict, 'measured',
      'the mutation must also flip the summary verdict, otherwise the T4 guard pins nothing');
    // The real module withholds the verdict on a transport failure.
    const { probeGap: realProbe } = await import('../src/gap.mjs');
    const realResult = await realProbe(
      [{ program: 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', payloads: 42 }],
      { url: 'https://mock.invalid/rpc', fetcher: failing },
    );
    assert.equal(realResult.rows[0].verdict, 'unknown');
    assert.equal(realResult.summary.verdict, 'no-verdict');
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await rm(path.join(ROOT, 'src', `.gap-mutant-${path.basename(tmp)}.mjs`), { force: true });
  }
});

function fakeAnchorAccount(idl) {
  // Same on-disk shape src/acquire.mjs decodes: Anchor header + deflate body.
  const body = zlib.deflateSync(Buffer.from(JSON.stringify(idl)));
  const header = Buffer.alloc(44);
  Buffer.from([24, 70, 98, 191, 58, 144, 123, 158]).copy(header);
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]).toString('base64');
}
