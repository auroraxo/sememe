// A LEGACY LOCK pins no origin — so nothing checks it, and the gate says
// "verified" about a provenance label it never looked at.
//
// WHAT WAS MEASURED (2026-11-07, this host):
//
//   The 2026-11-07 fix (src/receipt-digest.mjs) bound a receipt's DECLARED
//   origin to the receipt's own body, so a rewritten origin is named
//   `relabelled` instead of passing the CI gate silently. Two facts make that
//   binding evadable in the world that actually exists:
//
//   1. A receipt written BEFORE the fix carries NO digest fields. The
//      compatibility rule is deliberate and correct — "a legacy receipt is
//      never refused for lacking a digest" — refusing every pre-existing
//      store would break every user who already has one.
//
//   2. A lock written BEFORE the fix pins NO origin. The `origin` key is
//      optional in a lock entry, and checkLock guards the comparison with
//      `if (typeof pinnedOrigin === 'string')` — with no pinned origin the
//      check does not run AT ALL.
//
//   Together: an existing user (legacy store + legacy lock) who upgrades
//   sememe and re-runs `sememe verify` gets a GREEN GATE over a REWRITTEN
//   provenance label. Measured live on this host:
//
//     adopt  (published v0.4.10)  -> receipt WITHOUT digest fields
//     lock   (published v0.4.10)  -> lock WITHOUT an origin entry
//     rewrite receipt.origin -> "attacker/rewritten-origin"
//     verify (the FIXED tree, main f700942)
//       -> { violations: 0, verified: ["6EF8rrec..."] }, exit 0
//
//   The asymmetry that proves the guarantee is a lottery rather than a
//   contract: the SAME store, with the lock re-written by the new code,
//   DOES catch the same rewrite (`relabelled`, exit 1). Which file the user
//   happened to regenerate decides whether the label is protected.
//
//   The repair is one command (`sememe lock`), because writeLock already
//   pins `receipt.origin` for a legacy receipt. What was missing is that
//   verify does not SAY the binding is absent — it reports the program as
//   `verified`, which for a provenance claim it never checked is the green
//   lie this gate exists to prevent.
//
// WHAT THIS FILE PINS:
//
//   Q1  A legacy store + a legacy lock whose declared origin was REWRITTEN
//       must NOT verify clean. The receipt carries no digest, so only the
//       lock could know — and it must say it does not know, by name.
//
//   Q2  writeLock DOES pin a legacy receipt's declared origin (the one
//       command repair must actually repair; if it did not, Q1 would have no
//       way out).
//
//   Q3  CONTROLS (false-positive guards, expected green on the pre-fix tree):
//       (a) a lock written by the new code + an untouched legacy receipt
//           verifies clean with no relabel;
//       (b) the same lock + a rewritten origin is caught as `relabelled`
//           (the comparison path that already worked);
//       (c) an on-chain receipt declares NO origin, so a lock pinning none
//           for it is NOT a coverage gap — reporting one would be a false
//           positive on every pull-only store.
//
//   Q4  The refusal must NAME the origin, the lock, and the repair — not
//       merely report a count. An unbound origin that says only "violations:
//       1" would leave the user unable to tell the gap from damage.
//
// MUTATIONS (at the end of this file) must each turn a test red:
//   Z1  stop reporting an unbound origin            -> Q1 red
//   Z2  report it but do not count it as a violation -> Q4 red
//   Z3  stop pinning origin in writeLock            -> Q2 red
//   Z4  report a pull-only store as unbound         -> Q3c red (false positive)
//
// The claims this file does NOT make: the declared origin is still not
// VERIFIED (sememe never checks that the named repository exists); an
// attacker who rewrites BOTH the receipt and the committed lock is out of
// scope — that file is under git review; a lock is still not a signature.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const PUBLISHED = path.join(HERE, 'fixtures', 'pump-published-idl.json');
const ATTACKER_ORIGIN = 'attacker-rewritten-origin';

const { adopt } = await import('../src/adopt.mjs');
const { writeLock, checkLock } = await import('../src/lock.mjs');
const { canonicalJson } = await import('../src/canonical.mjs');

function runBin(args, cwd = ROOT) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
}

/** A store exactly as the PUBLISHED v0.4.10 left it: a receipt with NO
 * digest fields, because that release did not write any. */
async function legacyStore(origin = 'pump-fun-pump-public-docs') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-legacy-'));
  const receipt = await adopt(PUMP, PUBLISHED, dir, { source: 'published', origin });
  const receiptPath = path.join(dir, 'receipts', path.basename(receipt.receiptPath));
  const raw = JSON.parse(await readFile(receiptPath, 'utf8'));
  const storedOrigin = raw.origin;
  for (const key of ['originDigest', 'receiptDigest', 'originStatus', 'originNote']) delete raw[key];
  await writeFile(receiptPath, Buffer.from(canonicalJson(raw) + '\n'));
  return { dir, receiptPath, origin: storedOrigin };
}

/** A lock exactly as the PUBLISHED v0.4.10 left it: no `origin` key. */
async function legacyLock(dir, lockPath) {
  const names = await readdir(path.join(dir, 'receipts'));
  const receiptName = names.find((n) => n.startsWith(`${PUMP}-`));
  const receipt = JSON.parse(await readFile(path.join(dir, 'receipts', receiptName), 'utf8'));
  await writeFile(lockPath, Buffer.from(canonicalJson({
    lockVersion: 1,
    programs: {
      [PUMP]: {
        fingerprint: receipt.fingerprint,
        source: receipt.source,
        slot: receipt.slot,
        receipt: receiptName,
        instructions: receipt.instructionCount,
      },
    },
  }) + '\n'));
  return receiptName;
}

async function rewriteOrigin(receiptPath, next) {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.origin = next;
  await writeFile(receiptPath, Buffer.from(canonicalJson(receipt) + '\n'));
}

// ---------------------------------------------------------------------------
// Q1: a legacy store + legacy lock must catch a rewritten declared origin.
// ---------------------------------------------------------------------------
test('Q1: a legacy store + legacy lock does not verify clean over a rewritten declared origin', async () => {
  const { dir, receiptPath } = await legacyStore();
  const lockPath = path.join(dir, 'sememe.lock');
  const receiptName = await legacyLock(dir, lockPath);
  try {
    // Preconditions: this case must stay the legacy case, or the test is void.
    const raw = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(raw.originDigest, undefined, 'a legacy receipt must carry no origin digest');
    assert.equal(raw.receiptDigest, undefined, 'a legacy receipt must carry no body digest');
    const lockDoc = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(lockDoc.programs[PUMP].origin, undefined, 'a legacy lock must pin no origin');

    await rewriteOrigin(receiptPath, ATTACKER_ORIGIN);

    const report = await checkLock(dir, lockPath, { mode: 'warn' });
    assert.ok(report.violations > 0,
      'a store whose declared origin this lock never pinned must not report verified');
    assert.deepEqual(report.verified, [],
      'the program must not be listed as verified — the origin claim was never checked');
    const entry = [...report.unbound ?? [], ...report.relabelled].find((r) => r.program === PUMP);
    assert.ok(entry, `an unbound/changed origin must be reported, got ${JSON.stringify(report)}`);
    assert.match(entry.reason, /origin/i, `the refusal must name the origin, got: ${entry.reason}`);
    void receiptName;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Q2: the one-command repair must actually repair.
// ---------------------------------------------------------------------------
test('Q2: writeLock pins the declared origin of a legacy receipt', async () => {
  const { dir, origin } = await legacyStore();
  const lockPath = path.join(dir, 'sememe.lock');
  try {
    await writeLock(dir, lockPath);
    const doc = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(typeof doc.programs[PUMP].origin, 'string',
      'the lock must pin the declared origin even for a receipt without digests');
    assert.equal(doc.programs[PUMP].origin, origin);
    assert.equal(doc.programs[PUMP].originStatus, 'declared');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Q3: controls — the guards that must stay green.
// ---------------------------------------------------------------------------
test('Q3a: CONTROL — a new-code lock over an untouched legacy receipt verifies clean', async () => {
  const { dir } = await legacyStore();
  const lockPath = path.join(dir, 'sememe.lock');
  try {
    await writeLock(dir, lockPath);
    const report = await checkLock(dir, lockPath, { mode: 'warn' });
    assert.equal(report.violations, 0, 'an untouched store must verify clean');
    assert.deepEqual(report.verified, [PUMP]);
    assert.deepEqual(report.relabelled, []);
    assert.deepEqual(report.unbound ?? [], []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Q3b: CONTROL — the pin comparison path still catches a rewrite of a new-code lock', async () => {
  const { dir, receiptPath } = await legacyStore();
  const lockPath = path.join(dir, 'sememe.lock');
  try {
    await writeLock(dir, lockPath);
    await rewriteOrigin(receiptPath, ATTACKER_ORIGIN);
    const report = await checkLock(dir, lockPath, { mode: 'warn' });
    assert.equal(report.relabelled.length, 1, 'the rewrite must be caught by the pin comparison');
    assert.equal(report.relabelled[0].program, PUMP);
    assert.equal(report.violations, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Q3c: CONTROL — a pull-only store declaring no origin is NOT an unbound-origin violation', async () => {
  const { dir } = await legacyStore();
  const lockPath = path.join(dir, 'sememe.lock');
  try {
    // An ON-CHAIN receipt declares no origin at all (it names no file), so
    // the lock pins none for it and there is nothing to be unbound.
    const names = await readdir(path.join(dir, 'receipts'));
    const adoptedName = names.find((n) => n.startsWith(`${PUMP}-`));
    const receipt = JSON.parse(await readFile(path.join(dir, 'receipts', adoptedName), 'utf8'));
    delete receipt.origin;
    await writeFile(path.join(dir, 'receipts', adoptedName), Buffer.from(canonicalJson(receipt) + '\n'));
    await writeLock(dir, lockPath);
    const doc = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(doc.programs[PUMP].origin, undefined,
      'a receipt that declares no origin must not produce a pinned origin');
    const report = await checkLock(dir, lockPath, { mode: 'warn' });
    assert.equal(report.violations, 0, 'a store declaring no origin must not be reported unbound');
    assert.deepEqual(report.unbound ?? [], []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Q4: the refusal must be actionable, and the CLI must say it.
// ---------------------------------------------------------------------------
test('Q4: the refusal names the origin, the lock, and the repair', async () => {
  const { dir, receiptPath } = await legacyStore();
  const lockPath = path.join(dir, 'sememe.lock');
  await legacyLock(dir, lockPath);
  try {
    await rewriteOrigin(receiptPath, ATTACKER_ORIGIN);
    const report = await checkLock(dir, lockPath, { mode: 'warn' });
    const entry = [...report.unbound ?? [], ...report.relabelled].find((r) => r.program === PUMP);
    assert.ok(entry, 'the missing binding must be reported');
    assert.match(entry.reason, /origin/i, `must name the origin: ${entry.reason}`);
    assert.match(entry.reason, /lock/i, `must name the lock as the place the binding is missing: ${entry.reason}`);
    assert.match(entry.reason, /sememe lock/,
      `must name the one-command repair, got: ${entry.reason}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Q4b: the CLI exits 1 and names the unbound origin', async () => {
  const { dir, receiptPath } = await legacyStore();
  const lockPath = path.join(dir, 'sememe.lock');
  await legacyLock(dir, lockPath);
  try {
    await rewriteOrigin(receiptPath, ATTACKER_ORIGIN);
    const cli = runBin(['verify', '--store', dir, '--lock', lockPath]);
    assert.equal(cli.status, 1, `verify must exit 1, got ${cli.status}: ${cli.stderr}`);
    assert.match(cli.stderr + cli.stdout, /origin/i,
      `the CLI must name the origin, got: ${cli.stderr}${cli.stdout}`);
    assert.match(cli.stderr + cli.stdout, /sememe lock/,
      `the CLI must name the repair, got: ${cli.stderr}${cli.stdout}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Q4c: the CLI still exits 0 on an untouched legacy store after re-locking', async () => {
  const { dir } = await legacyStore();
  const lockPath = path.join(dir, 'sememe.lock');
  try {
    const cli = runBin(['lock', '--store', dir, '--out', lockPath]);
    assert.equal(cli.status, 0, `lock must succeed: ${cli.stderr}`);
    const verify = runBin(['verify', '--store', dir, '--lock', lockPath]);
    assert.equal(verify.status, 0, `verify must be clean: ${verify.stderr}`);
    assert.match(verify.stdout, /"violations": 0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MUTATIONS
// ---------------------------------------------------------------------------
// MUTATIONS
//
// Every mutation is driven through the CLI (a FRESH process). The repo's own
// convention: `src/lock.mjs` is imported once by `test/`, so editing it in
// place would only ever test the module cache. A spawned `node bin/sememe.mjs`
// re-reads the mutated source, which is the mutation's whole point.
//
// Each mutation must turn the corresponding Q-test RED; the assertion inside
// each block is the Q-condition, so a surviving mutation fails it here.
// ---------------------------------------------------------------------------
const LOCK = path.join(ROOT, 'src', 'lock.mjs');

async function withMutatedLock(mutate, run) {
  const original = await readFile(LOCK, 'utf8');
  const mutated = mutate(original);
  assert.notEqual(mutated, original, 'the mutation must actually change the source');
  try {
    await writeFile(LOCK, mutated, 'utf8');
    await run();
  } finally {
    await writeFile(LOCK, original, 'utf8');
  }
}

/** legacy store + legacy lock + rewritten origin, verified by a fresh CLI. */
async function verifyLegacyRewritten() {
  const { dir, receiptPath } = await legacyStore();
  const lockPath = path.join(dir, 'sememe.lock');
  await legacyLock(dir, lockPath);
  try {
    await rewriteOrigin(receiptPath, ATTACKER_ORIGIN);
    return runBin(['verify', '--store', dir, '--lock', lockPath]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('Z1: not reporting an unbound origin turns Q1 red', async () => {
  await withMutatedLock(
    (src) => src.replace(
      '    } else if (storeOrigin !== null) {',
      '    } else if (false) {',
    ),
    async () => {
      const cli = await verifyLegacyRewritten();
      assert.notEqual(cli.status, 1,
        `the mutation survived: verify still exits 1 over a rewritten origin`);
    },
  );
});

test('Z2: reporting it without counting it turns Q4 red', async () => {
  await withMutatedLock(
    (src) => src.replace(
      '    + report.unverified.length + report.relabelled.length + report.unbound.length;',
      '    + report.unverified.length + report.relabelled.length;',
    ),
    async () => {
      const cli = await verifyLegacyRewritten();
      assert.notEqual(cli.status, 1,
        `the mutation survived: an unbound origin still reaches the gate as a violation`);
    },
  );
});

test('Z3: not pinning origin in writeLock turns Q2 red', async () => {
  await withMutatedLock(
    (src) => src.replace(
      '      ...(receipt.origin === undefined || receipt.origin === null ? {} : {',
      '      ...(true ? {} : {',
    ),
    async () => {
      const { dir } = await legacyStore();
      const lockPath = path.join(dir, 'sememe.lock');
      try {
        const cli = runBin(['lock', '--store', dir, '--out', lockPath]);
        assert.equal(cli.status, 0, `lock must succeed: ${cli.stderr}`);
        const doc = JSON.parse(await readFile(lockPath, 'utf8'));
        assert.notEqual(typeof doc.programs[PUMP].origin, 'string',
          'the mutation survived: writeLock still pins the declared origin, so the repair is intact');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

test('Z4: reporting a store that declares no origin as unbound turns Q3c red (false-positive guard)', async () => {
  await withMutatedLock(
    (src) => src.replace(
      '    } else if (storeOrigin !== null) {',
      '    } else if (true) {',
    ),
    async () => {
      const { dir } = await legacyStore();
      const lockPath = path.join(dir, 'sememe.lock');
      try {
        // A receipt with NO declared origin (what every pull produces).
        const names = await readdir(path.join(dir, 'receipts'));
        const adoptedName = names.find((n) => n.startsWith(`${PUMP}-`));
        const receipt = JSON.parse(await readFile(path.join(dir, 'receipts', adoptedName), 'utf8'));
        delete receipt.origin;
        await writeFile(path.join(dir, 'receipts', adoptedName), Buffer.from(canonicalJson(receipt) + '\n'));
        const lock = runBin(['lock', '--store', dir, '--out', lockPath]);
        assert.equal(lock.status, 0, `lock must succeed: ${lock.stderr}`);
        const cli = runBin(['verify', '--store', dir, '--lock', lockPath]);
        assert.notEqual(cli.status, 0,
          'the mutation survived: a store declaring no origin was still reported unbound');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
