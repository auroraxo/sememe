// The cross-program account-union measurement: does the arbitration generalize
// beyond the one program it was built on?
//
// This file pins the committed artifact of tools/measure-account-union-cross.mjs:
//
//   research/account-union-cross-2026-11-08.json
//
// WHY THE ARTIFACT MATTERS. v0.4.12 shipped `sememe account --union` with a
// measurement over exactly ONE program (pump.fun) and the README named that
// as a limit. A feature measured on one program can look universal and be
// narrow. This measurement puts the SAME arbitration over every program the
// repo holds real mainnet account bytes for, so the headline can be falsified
// instead of extrapolated.
//
// WHAT THE MEASUREMENT FOUND (the point of pinning it):
//
//   6 programs, 74 real accounts, 4 of them with TWO interface copies:
//     pump.fun          12 accounts   recovery 6   (the program it was built on)
//     meteora-vault     12 accounts   recovery 0   — the second copy RENAMES
//                                              the account (vault vs Vault), so
//                                              Anchor's name-derived
//                                              discriminator can never match
//     meteora-damm-v1   11 accounts   recovery 0   — both copies decode, both
//                                              leave the same bytes unexplained
//     openbook-v2        4 accounts   recovery 0   — both copies AGREE, and
//                                              both were already byte-exact
//     whirlpool         27 accounts   single-source control
//     kamino-lend        8 accounts   single-source control
//
//   So the honest headline is NOT "the union recovers accounts". It is:
//   "on 1 of 4 two-source programs the arbitration recovered a byte-exact
//   answer the single-source path did not have; on the other 3 the copies
//   agreed, disagreed without deciding, or could not even name the account."
//   A reader who saw only the pump.fun numbers would have over-claimed.
//
// THE INVARIANTS are the falsification half, and they must stay 0:
//   * the union never regresses an account the plain path answered exactly;
//   * the union never refuses an account the plain path answered;
//   * a single-source control never reports anything but `single_source`;
//   * plain and union never name DIFFERENT account types for the same bytes.
//
// The suite's job: keep the fixed tree fixed AND keep the artifact honest —
// a hand-edited artifact that claimed a broader recovery than the tool derives
// would make this file prove nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-account-union-cross.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'account-union-cross-2026-11-08.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));
const byName = Object.fromEntries(artifact.programs.map((p) => [p.name, p]));

test('the artifact is the one the tool produces right now (no hand-edited numbers)', () => {
  const fresh = path.join(ROOT, 'research', '.account-union-cross-fresh.json');
  try {
    execFileSync(process.execPath, [TOOL, '--out', fresh], { cwd: ROOT, stdio: 'ignore' });
    const produced = JSON.parse(readFileSync(fresh, 'utf8'));
    const strip = (r) => {
      const copy = { ...r };
      delete copy.measuredAt;
      // The per-row reasons are long; the verdict fields are what the
      // comparison is about.
      copy.programs = copy.programs.map((p) => ({
        ...p,
        rows: p.rows.map((row) => ({
          address: row.address,
          bytes: row.bytes,
          plain: row.plain,
          union: row.union && {
            verdict: row.union.verdict,
            account: row.union.account,
            consumed: row.union.consumed,
            trailing: row.union.trailing,
            roundTripByteExact: row.union.roundTripByteExact,
            sourcesAgree: row.union.sourcesAgree,
            basis: row.union.basis,
          },
        })),
      }));
      return copy;
    };
    assert.deepEqual(strip(produced), strip(artifact),
      'the committed artifact is not what the tool derives — re-run the tool and commit its output');
  } finally {
    rmSync(fresh, { force: true });
  }
});

test('the regression invariants are 0 — the union never makes an answer worse', () => {
  assert.deepEqual(artifact.invariants.unionRegressedWherePlainWasExact, [],
    'the union must never answer worse than the plain path on the same bytes');
  assert.deepEqual(artifact.invariants.unionRefusedWherePlainAnswered, [],
    'the union must never refuse what the plain path answered');
  assert.deepEqual(artifact.invariants.controlVerdictNotSingleSource, [],
    'a single-source store must report single_source, nothing else');
  assert.deepEqual(artifact.invariants.plainUnionNameMismatch, [],
    'plain and union must never name different account types for the same bytes');
  assert.equal(artifact.ok, true);
});

test('the artifact covers every program with real account bytes — the old one-program limit is gone', () => {
  assert.equal(artifact.programs.length, 6);
  assert.equal(artifact.totals.programs, 6);
  assert.equal(artifact.totals.twoSourcePrograms, 4);
  assert.equal(artifact.totals.controlPrograms, 2);
  assert.ok(artifact.totals.accounts >= 70,
    `expected the harvest of six programs, got ${artifact.totals.accounts}`);
  for (const name of ['pump.fun', 'meteora-vault', 'meteora-damm-v1', 'openbook-v2', 'whirlpool', 'kamino-lend']) {
    assert.ok(byName[name], `the artifact must cover ${name}`);
  }
});

test('the headline is honest: recovery happened on ONE of the four two-source programs', () => {
  // The falsifiable claim, stated as the measurement found it — NOT as the
  // pump.fun-only artifact suggested.
  assert.equal(artifact.totals.twoSourceProgramsWithRecovery, 1,
    'arbitration recovered a byte-exact answer on exactly one two-source program');
  assert.equal(artifact.totals.recoveredByArbitration, 6);
  assert.equal(byName['pump.fun'].summary.recoveredByArbitration, 6);
  assert.equal(byName['meteora-vault'].summary.recoveredByArbitration, 0);
  assert.equal(byName['meteora-damm-v1'].summary.recoveredByArbitration, 0);
  assert.equal(byName['openbook-v2'].summary.recoveredByArbitration, 0);

  // And the three non-recovering programs are non-recovering for DIFFERENT,
  // named reasons — the difference is the finding.
  assert.equal(byName['meteora-vault'].summary.secondaryRefused, 12,
    'meteora-vault: the second copy could not even name the account');
  assert.deepEqual(byName['meteora-vault'].summary.verdicts, { primary_only: 12 });
  assert.deepEqual(byName['meteora-damm-v1'].summary.verdicts, { layout_drift: 11 },
    'meteora-damm-v1: both copies decode and disagree, neither is byte-exact');
  assert.deepEqual(byName['openbook-v2'].summary.verdicts, { agree: 4 },
    'openbook-v2: both copies agree and were already byte-exact');
});

test('the controls are untouched: single-source programs answer exactly as before', () => {
  for (const name of ['whirlpool', 'kamino-lend']) {
    const program = byName[name];
    assert.equal(program.sources.twoSource, false);
    assert.equal(program.summary.plainByteExact, program.accounts,
      `${name}: the plain path answered every account byte-exactly`);
    assert.equal(program.summary.unionByteExact, program.accounts,
      `${name}: the union must not change a byte-exact answer`);
    assert.deepEqual(Object.keys(program.summary.verdicts), ['single_source']);
  }
});

test('the meteora-vault refusal is diagnosed as a RENAME, not as a missing account', () => {
  // The finding this measurement produced: the second copy declares the
  // account under a different spelling, and Anchor derives the account
  // discriminator from the exact name — so the copy can never identify the
  // deployed bytes, whatever its layout says.
  const rows = byName['meteora-vault'].rows;
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.union.verdict, 'primary_only');
    assert.equal(row.union.secondary.decoded, false);
    const reason = row.union.secondary.refusedReason;
    assert.match(reason, /DOES declare the account, as "vault"/,
      `the rename must be named: ${reason}`);
    assert.match(reason, /derives an account discriminator from the exact name/,
      `the mechanism must be explained: ${reason}`);
    assert.match(reason, /"Vault"/,
      `the deployed spelling must be named: ${reason}`);
  }
});

test('the artifact carries no host path — a committed artifact with an absolute path is a snapshot', () => {
  const serialized = JSON.stringify(artifact);
  assert.ok(!serialized.includes('/home/aurora/'),
    'the artifact carries an absolute host path — it will not reproduce on CI');
  assert.ok(!serialized.includes('/tmp/'),
    'the artifact carries a scratch-directory path — it will not reproduce on CI');
});
