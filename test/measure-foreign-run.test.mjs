// Controls for tools/measure-foreign-run.mjs — the instrument that turns the
// card's "ein fremder Lauf / 0 Fremdnutzer" sentence into a measured verdict.
// An untested adoption instrument silently rots (a wrong owner filter counts
// the owner as a stranger; a merge reads as adoption; a partial fetch reads
// as absence), so the falsifiable decision paths are exercised against
// controlled real API responses that are cheap and stable — same convention
// as signerd's test/measure-adoption.test.mjs.
//
// The probe shells out to `gh api` and reaches three registries; without a
// token or egress it cannot run at all, and asserting on that failure would
// measure the missing dependency, not the instrument. Skip with a named
// reason when the dependency is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const TOOL = path.join(import.meta.dirname, '..', 'tools', 'measure-foreign-run.mjs');

async function ghAuthed() {
  try {
    await run('gh', ['auth', 'status'], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

test('foreign-run probe refuses a verdict on a nonexistent repo (exit 3)', async (t) => {
  if (!(await ghAuthed())) {
    t.skip('gh not authenticated; foreign-run probe needs live GitHub API');
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'sememe-adopt-'));
  try {
    await assert.rejects(
      run(process.execPath, [TOOL, '--out', path.join(dir, 'x.json')], {
        env: { ...process.env, ADOPTION_REPO: 'auroraxo/does-not-exist-404' },
      }),
      (err) => err.code === 3
    );
    // and no report file is written for a failed run
    await assert.rejects(readFile(path.join(dir, 'x.json'), 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('foreign-run probe on sememe emits a verdict and complete report', async (t) => {
  if (!(await ghAuthed())) {
    t.skip('gh not authenticated; foreign-run probe needs live GitHub API');
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'sememe-adopt-'));
  try {
    const out = path.join(dir, 'foreign-run.json');
    await run(process.execPath, [TOOL, '--out', out], { timeout: 120000 });
    const report = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(report.repo, 'auroraxo/sememe');
    assert.equal(report.complete, true);
    assert.equal(report.dataSourcesFailed, 0);
    // classification is one of the three named classes, never prose
    assert.ok(
      ['user-one-evidence', 'distributed-not-consumed', 'not-distributed-not-consumed'].includes(
        report.verdict.class
      )
    );
    // the owner exclusion actually ran: no signal names the owner as actor
    for (const s of report.verdict.signals) {
      assert.ok(!/^star by auroraxo$/.test(s), `owner leaked into signals: ${s}`);
      assert.ok(!/^fork by auroraxo$/.test(s), `owner leaked into signals: ${s}`);
      assert.ok(!/by auroraxo\b/.test(s), `owner authored a signal: ${s}`);
    }
    // the mention sweep was bucketed, and no bucket hides partial fetches
    assert.ok(report.mentionSweep.total !== null, 'mention sweep must be measured');
    assert.ok(
      report.mentionSweep.fetched <= report.mentionSweep.total,
      'fetched cannot exceed total'
    );
    // the owner's own slug threads are bucketed as OWN, not as strangers
    assert.ok(
      report.mentionSweep.buckets.selfAuthoredSlug >= 1,
      'the three known self-authored slug threads must land in the OWN bucket'
    );
    // the two known outbound threads were measured, with author classification
    const refs = report.outbound.map((o) => o.ref);
    assert.ok(refs.includes('step-finance-oss/step-ingestooor#1'), 'outbound #1 missing');
    assert.ok(refs.includes('jup-ag/rfq-webhook-toolkit#96'), 'outbound #96 missing');
    // registries measured with positive controls
    assert.equal(report.registries.controls.npm, 'ok');
    assert.equal(report.registries.controls.cratesIo, 'ok');
    assert.ok(['found', 'not-found'].includes(report.registries.npm));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A data source that cannot be read must yield NO VERDICT, never a verdict
// with that channel silently dropped (the crates.io-403 / partial-fetch
// lesson, applied to the outbound-thread channel).
test('an unparseable outbound ref yields no verdict (exit 3, no report)', async (t) => {
  if (!(await ghAuthed())) {
    t.skip('gh not authenticated; foreign-run probe needs live GitHub API');
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'sememe-adopt-'));
  try {
    const out = path.join(dir, 'unparseable.json');
    await assert.rejects(
      run(process.execPath, [TOOL, '--out', out], {
        env: { ...process.env, ADOPTION_OUTBOUND: 'some/repo-without-a-number' },
        timeout: 120000,
      }),
      (err) => err.code === 3
    );
    // The report IS written on a partial run (D7: a report without a verdict
    // is the honest artifact), but it must say no-verdict — never an
    // absence-looking classification built on the failed source.
    const partial = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(partial.verdict.class, 'no-verdict');
    assert.equal(partial.complete, false);
    assert.ok(partial.dataSourcesFailed > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
