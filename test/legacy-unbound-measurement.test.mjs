// The measurement of the LEGACY case must be reproducible, not a claim.
//
// The defect this file's tool measures (2026-11-07, this host):
//
//   An existing user's store and lock were both written before origin pinning
//   existed. A legacy receipt carries no digest fields; a legacy lock pins no
//   origin. checkLock's comparison — guarded by
//   `if (typeof pinnedOrigin === 'string')` — therefore did not run AT ALL.
//
//   Measured, on the SAME files through both gates:
//
//     pre-fix  (f700942): exit 0, violations 0, verified: [program]
//     post-fix (this tree): exit 1, unbound: [program], with the reason
//
//   The pre-fix "verified" is the defect: the gate certified a provenance
//   label it never pinned.
//
// WHAT THIS FILE PINS:
//
//   M1  The tool exists and runs, and its own verdict is EMPTY (no violated
//       expectation inside the measurement).
//   M2  The committed artifact is the one the tool produces right now — no
//       hand-edited numbers.
//   M3  The artifact records the measured LADDER: the pre-fix gate passed
//       (exit 0) and the post-fix gate refused (exit 1), on identical files.
//   M4  The artifact records the CONTROL: a lock written by the fixed code
//       first catches the same rewrite as `relabelled` (not `unbound`).
//   M5  The artifact records the FALSE-POSITIVE GUARD: a store that declares
//       no origin (what every `sememe pull` produces) stays clean.
//   M6  The artifact records the LIMIT of the repair: `sememe lock` is a
//       snapshot of what the store says NOW, so re-running it after an attack
//       binds the attacker's label. The limit must be measured, not implied.
//
// The claims this file does NOT make: that the declared origin is verified;
// that a lock is a signature; that an attacker who rewrites both the store
// and the committed lock is stopped (that file is under git review).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-legacy-unbound.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'legacy-unbound-origin-2026-11-07.json');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

test('M1: the measurement tool exists and its own verdict is empty', async () => {
  const source = await readFile(TOOL, 'utf8');
  assert.ok(source.length > 0, 'the tool must exist');
  assert.deepEqual(artifact.verdict.violations, [],
    'the measurement must not carry a violated expectation — one of the checks inside the tool failed');
});

test('M2: the committed artifact is the one the tool produces right now (no hand-edited numbers)', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtemp, readFile: rf, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-unbound-artifact-'));
  const fresh = path.join(dir, 'artifact.json');
  try {
    const res = spawnSync(process.execPath, [TOOL, '--out', fresh], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    });
    if (res.status !== 0) {
      if (/Unmeasurable/.test(res.stderr ?? '')) {
        t.skip(`pre-fix commit could not be fetched: ${String(res.stderr).split('\n')[0]}`);
        return;
      }
      throw Error(`measurement tool failed (${res.status}): ${res.stderr}${res.stdout}`);
    }
    const produced = JSON.parse(await rf(fresh, 'utf8'));
    delete produced.measuredAt;
    delete artifact.measuredAt;
    assert.deepEqual(produced, artifact,
      'the committed artifact must be exactly what the tool measures now');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('M3: the artifact records the measured ladder — pre-fix passed, post-fix refused, on identical files', () => {
  assert.equal(artifact.setup.receiptHasOriginDigest, false,
    'the measured receipt must be a legacy one: no digest fields');
  assert.equal(artifact.setup.lockPinsOrigin, false,
    'the measured lock must be a legacy one: no pinned origin');
  assert.equal(artifact.t1.exit, 0,
    'the PRE-FIX gate must have passed — that is the defect being measured');
  assert.equal(artifact.t1.violations, 0,
    'the pre-fix gate must have reported no violation');
  assert.deepEqual(artifact.t1.verified, ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
    'the pre-fix gate must have certified the program it never checked');
  assert.equal(artifact.t2.exit, 1,
    'the POST-FIX gate must refuse the same files');
  assert.equal(artifact.t2.unbound, 1, 'the post-fix gate must name exactly one unbound origin');
  assert.deepEqual(artifact.t2.verified, [],
    'the post-fix gate must not certify a label it cannot compare');
  assert.match(artifact.t2.reason, /sememe lock/,
    `the refusal must name the one-command repair, got: ${artifact.t2.reason}`);
});

test('M4: the artifact records the control — a fixed-code lock catches the rewrite as `relabelled`', () => {
  assert.equal(artifact.t4.exit, 1, 'the control must refuse');
  assert.equal(artifact.t4.relabelled, 1, 'the control must be caught as `relabelled`');
  assert.equal(artifact.t4.unbound, 0,
    'the control must NOT be reported unbound — it has a pinned origin');
  assert.ok(artifact.t4.lockPinsOrigin, 'the control lock must pin an origin');
});

test('M5: the artifact records the false-positive guard — a store with no declared origin stays clean', () => {
  assert.equal(artifact.t5.exit, 0,
    'a store that declares no origin must stay clean — reporting it unbound would fail every pull-only store');
  assert.equal(artifact.t5.lockPinsOrigin, null,
    'such a lock must pin no origin');
});

test('M6: the artifact records the LIMIT of the repair, measured', () => {
  assert.equal(artifact.t3.lockPinsOriginalLabelOnCleanStore, 'pump-fun-pump-public-docs',
    'the repair must pin the ORIGINAL label on a clean store');
  assert.equal(artifact.t3.verifyAfterRepairOnCleanStore, 0,
    'the repaired gate must be green on a clean store');
  assert.equal(artifact.t3.verifyAfterAttackingTheRepair, 1,
    'a committed lock must catch a later rewrite');
  assert.equal(artifact.t3.boundTheAttackerLabelAfterAttack, 'attacker-rewritten-origin',
    'the limit must be MEASURED: re-running the repair after an attack binds the attacker\'s label');
  assert.match(artifact.t3.limit, /snapshot/i,
    'the artifact must state the limit in words, not only in numbers');
});
