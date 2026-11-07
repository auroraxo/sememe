// DOES AN EXISTING USER'S COMMITTED sememe.lock CERTIFY A DECLARED ORIGIN IT
// NEVER PINNED?
//
// The question is about the world that exists, not the world the fix assumed:
// a user whose store and lock were both written by a release BEFORE origin
// pinning existed. That is every store that exists today, because pinning
// origin landed on 2026-11-07 and no release carrying it has shipped.
//
// THE TWO FACTS THAT MAKE THE LEGACY CASE UNCOVERED:
//   - the legacy receipt carries no digest fields (src/receipt-digest.mjs
//     landed later, and refusing such receipts would break every existing
//     store — the compatibility rule is deliberate);
//   - the legacy lock pins no origin, so checkLock's comparison — guarded by
//     `if (typeof pinnedOrigin === 'string')` — did not run at all.
//
// WHAT IS MEASURED, on the SAME files through both gates:
//   T1  pre-fix gate  (commit f700942, extracted with `git archive`)
//   T2  post-fix gate (this tree)
//   T3  the one-command repair, and what it actually binds
//   T4  the control: a lock written by the FIXED code FIRST, then the same
//       attack — this is the case the 2026-11-07 fix already protected
//   T5  the control's opposite: a store that declares NO origin (what every
//       `sememe pull` produces) must never be reported as unbound
//
// HONEST LIMIT, measured in T3 rather than argued: `sememe lock` is a
// SNAPSHOT of what the store says now, not a proof of what it said before.
// Re-running it after an attack binds the attacker's label. The protection
// comes from committing the lock BEFORE any rewrite; the repair command
// restores a working gate, it does not recover a lost origin.
//
// Usage: node tools/measure-legacy-unbound.mjs [--out <file>] [--prefix <commit>]

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  return value;
};
const OUT = flag('--out', path.join(ROOT, 'research', 'legacy-unbound-origin-2026-11-07.json'));
const PREFIX = flag('--prefix', 'f700942');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const IDL = path.join(ROOT, 'test', 'fixtures', 'pump-published-idl.json');
const ORIGIN = 'pump-fun-pump-public-docs';
const REWRITTEN = 'attacker-rewritten-origin';

const run = (bin, args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 60_000 });
const out = (result) => {
  // `verify` writes the report to stdout and (in warn mode with violations) a
  // note to stderr — concatenating them would corrupt the JSON. Try stdout
  // first, then the concatenation, then each side alone.
  for (const text of [result.stdout, `${result.stdout ?? ''}${result.stderr ?? ''}`, result.stderr]) {
    if (!text) continue;
    try { return JSON.parse(text); } catch { /* try the next candidate */ }
  }
  return null;
};

/** The pre-fix tree could not be read. Not a measurement failure: the caller
 * reports it as a named skip so CI never turns green over an unmeasured claim
 * (the repo's own rule for a pinned tag that is neither local nor fetchable). */
class Unmeasurable extends Error {}

/** A pre-fix tree, extracted from git history by commit — stable forever,
 * unlike "the previous commit", which stops being pre-fix once this change
 * lands. */
function extractPrefix(commit, dir) {
  // If the commit is not local (e.g. a depth-1 CI checkout), fetch it first.
  const probe = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
  if (probe.status !== 0) {
    spawnSync('git', ['fetch', '--depth=50', 'origin', commit], { cwd: ROOT, stdio: 'ignore' });
    const recheck = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
    if (recheck.status !== 0) {
      // Unmeasurable, not failed: the pre-fix tree is unavailable. The caller
      // reports this as a NAMED SKIP — never as a green run over an
      // unmeasured claim, and never as a red run for a missing commit.
      throw new Unmeasurable(`the pre-fix commit ${commit} is neither local nor fetchable from origin`);
    }
  }
  try {
    const tar = execFileSync('git', ['archive', '--format=tar', commit], { cwd: ROOT, maxBuffer: 1 << 28 });
    execFileSync('tar', ['-x', '-C', dir], { input: tar });
  } catch (error) {
    throw new Unmeasurable(`cannot extract the pre-fix commit ${commit}: ${String(error?.message ?? error).slice(0, 200)}`);
  }
  return path.join(dir, 'bin', 'sememe.mjs');
}

/** The legacy world: a receipt WITHOUT digest fields and a lock WITHOUT an
 * origin entry — exactly what a published pre-fix release writes. */
function legacyPair(base, label) {
  const store = path.join(base, `store-${label}`);
  fs.mkdirSync(store, { recursive: true });
  const adopt = run(path.join(ROOT, 'bin', 'sememe.mjs'),
    ['adopt', PUMP, IDL, '--store', store, '--origin', ORIGIN]);
  if (adopt.status !== 0) throw Error(`adopt failed: ${adopt.stdout}${adopt.stderr}`);
  const receiptName = fs.readdirSync(path.join(store, 'receipts'))[0];
  const receiptPath = path.join(store, 'receipts', receiptName);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  // Downgrade to a legacy receipt: strip everything the fix added.
  for (const key of ['originDigest', 'receiptDigest', 'originStatus', 'originNote']) delete receipt[key];
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  const lockPath = path.join(base, `sememe-${label}.lock`);
  const lockDoc = {
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
  };
  fs.writeFileSync(lockPath, `${JSON.stringify(lockDoc)}\n`);
  // The state AT CREATION, captured before any later step rewrites the file.
  return { store, lockPath, receiptPath, legacyLockDoc: lockDoc, legacyReceipt: receipt };
}

function measure() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-unbound-'));
  const fixes = path.join(base, 'prefix-tree');
  fs.mkdirSync(fixes, { recursive: true });
  const preBin = extractPrefix(PREFIX, fixes);
  const postBin = path.join(ROOT, 'bin', 'sememe.mjs');

  // ---- T1: the same legacy store + legacy lock through the PRE-FIX gate ----
  const pre = legacyPair(base, 'a');
  const preBefore = JSON.parse(fs.readFileSync(pre.receiptPath, 'utf8'));
  fs.writeFileSync(pre.receiptPath,
    `${JSON.stringify({ ...preBefore, origin: REWRITTEN })}\n`);
  const t1 = run(preBin, ['verify', '--store', pre.store, '--lock', pre.lockPath]);
  const t1Warn = run(preBin, ['verify', '--store', pre.store, '--lock', pre.lockPath, '--mode', 'warn']);

  // ---- T2: the SAME files through the POST-FIX gate -----------------------
  const t2 = run(postBin, ['verify', '--store', pre.store, '--lock', pre.lockPath]);
  const t2Warn = run(postBin, ['verify', '--store', pre.store, '--lock', pre.lockPath, '--mode', 'warn']);

  // ---- T3: the one-command repair, measured for what it actually binds ----
  const t3Lock = run(postBin, ['lock', '--store', pre.store, '--out', pre.lockPath]);
  const afterRepairLock = JSON.parse(fs.readFileSync(pre.lockPath, 'utf8'));
  const t3Verify = run(postBin, ['verify', '--store', pre.store, '--lock', pre.lockPath]);
  // ...and the same repair run on a CLEAN store, which is the case the
  // repair is for: the lock then pins the ORIGINALLY declared label.
  const clean = legacyPair(base, 'clean');
  const cleanGood = JSON.parse(fs.readFileSync(clean.receiptPath, 'utf8')).origin;
  const t3CleanLock = run(postBin, ['lock', '--store', clean.store, '--out', clean.lockPath]);
  const t3CleanDoc = JSON.parse(fs.readFileSync(clean.lockPath, 'utf8'));
  const t3CleanVerify = run(postBin, ['verify', '--store', clean.store, '--lock', clean.lockPath]);
  // ...and only THEN the attack: this is the guarantee.
  fs.writeFileSync(clean.receiptPath,
    `${JSON.stringify({ ...JSON.parse(fs.readFileSync(clean.receiptPath, 'utf8')), origin: REWRITTEN })}\n`);
  const t3AfterAttack = run(postBin, ['verify', '--store', clean.store, '--lock', clean.lockPath]);

  // ---- T4: control — the lock written by the FIXED code first ------------
  // The repair applied to a CLEAN store, THEN the attack: this is the case
  // the 2026-11-07 fix already covered (relabelled), and it must still be.
  const ctl = legacyPair(base, 'control');
  run(postBin, ['lock', '--store', ctl.store, '--out', ctl.lockPath]);
  const ctlLock = JSON.parse(fs.readFileSync(ctl.lockPath, 'utf8'));
  fs.writeFileSync(ctl.receiptPath,
    `${JSON.stringify({ ...JSON.parse(fs.readFileSync(ctl.receiptPath, 'utf8')), origin: REWRITTEN })}\n`);
  const t4 = run(postBin, ['verify', '--store', ctl.store, '--lock', ctl.lockPath]);
  const t4Warn = run(postBin, ['verify', '--store', ctl.store, '--lock', ctl.lockPath, '--mode', 'warn']);
  const t4Report = out(t4Warn);

  // ---- T5: control — a store that declares NO origin (a plain pull) -------
  const pull = legacyPair(base, 'pull');
  const pullReceiptPath = pull.receiptPath;
  const pullReceipt = JSON.parse(fs.readFileSync(pullReceiptPath, 'utf8'));
  delete pullReceipt.origin;
  fs.writeFileSync(pullReceiptPath, `${JSON.stringify(pullReceipt)}\n`);
  run(postBin, ['lock', '--store', pull.store, '--out', pull.lockPath]);
  const t5 = run(postBin, ['verify', '--store', pull.store, '--lock', pull.lockPath]);
  const t5Doc = JSON.parse(fs.readFileSync(pull.lockPath, 'utf8'));

  const t1Report = out(t1Warn);
  const t2Report = out(t2Warn);
  const verdict = {
    violations: [],
    preFixExits: t1.status,
    postFixExits: t2.status,
  };
  if (t1.status !== 0) verdict.violations.push('the pre-fix gate was expected to pass over the rewrite');
  if (t2.status !== 1) verdict.violations.push('the post-fix gate must refuse the legacy case');
  if (t1Report?.violations !== 0) verdict.violations.push('pre-fix reported a violation it cannot support');
  if (t2Report?.unbound?.length !== 1) verdict.violations.push('post-fix must name exactly one unbound origin');
  if (t4.status !== 1) verdict.violations.push('the control (lock first) must catch the rewrite');
  if (t4Report?.relabelled?.length !== 1) verdict.violations.push('the control must be caught as `relabelled`, not as `unbound`');
  if ((t4Report?.unbound?.length ?? 0) !== 0) verdict.violations.push('the control must not be reported unbound — it has a pinned origin');
  if (t5.status !== 0) verdict.violations.push('a store declaring no origin must stay clean');
  if (t3CleanDoc.programs[PUMP].origin !== cleanGood) verdict.violations.push('the repair must pin the ORIGINAL label on a clean store');
  if (t3AfterAttack.status !== 1) verdict.violations.push('a committed lock must catch a later rewrite');

  fs.rmSync(base, { recursive: true, force: true });

  return {
    tool: 'tools/measure-legacy-unbound.mjs',
    question: 'does an existing user\'s committed sememe.lock certify a declared origin it never pinned?',
    preFix: { commit: PREFIX, tree: 'extracted from git history with `git archive`' },
    postFix: { tree: 'this tree', binary: path.relative(ROOT, postBin) },
    setup: {
      receiptFields: Object.keys(preBefore),
      receiptHasOriginDigest: preBefore.originDigest !== undefined,
      lockPinsOrigin: pre.legacyLockDoc.programs[PUMP]?.origin !== undefined,
      note: 'built by this tree, then downgraded to a legacy receipt + legacy lock, so BOTH gates see identical files',
    },
    t1: {
      question: 'the PRE-FIX gate over a legacy store whose declared origin was rewritten',
      exit: t1.status,
      violations: t1Report?.violations,
      verified: t1Report?.verified,
      relabelled: t1Report?.relabelled?.length,
      // The pre-fix report has no `unbound` field AT ALL — absent, not zero.
      // Written out as null so the artifact records that it was missing
      // rather than quietly reporting a count of zero.
      unbound: t1Report?.unbound === undefined ? null : t1Report.unbound.length,
      hasUnboundField: t1Report !== null && 'unbound' in t1Report,
      stderrHead: (t1.stderr || '').slice(0, 300),
      note: 'exit 0 with `verified: [program]` is the defect: the gate certified a label it never pinned',
    },
    t2: {
      question: 'the POST-FIX gate over the SAME files',
      exit: t2.status,
      violations: t2Report?.violations,
      verified: t2Report?.verified,
      unbound: t2Report?.unbound?.length,
      reason: t2Report?.unbound?.[0]?.reason ?? null,
      stderrHead: (t2.stderr || '').slice(0, 400),
    },
    t3: {
      question: 'what the one-command repair actually binds',
      repairExit: t3Lock.status,
      lockPinsOriginalLabelOnCleanStore: t3CleanDoc.programs[PUMP]?.origin,
      cleanLockExit: t3CleanLock.status,
      verifyAfterRepairOnCleanStore: t3CleanVerify.status,
      verifyAfterAttackingTheRepair: t3AfterAttack.status,
      boundTheAttackerLabelAfterAttack: afterRepairLock.programs[PUMP]?.origin,
      limit: '`sememe lock` is a SNAPSHOT of what the store says now, not a proof of what it said before — '
        + 're-running it after an attack binds the attacker\'s label. The guarantee comes from committing the '
        + 'lock BEFORE any rewrite (measured: that path refuses with exit 1); the repair restores a working gate, '
        + 'it does not recover a lost origin.',
    },
    t4: {
      question: 'control — a lock written by the FIXED code first, then the same rewrite',
      lockPinsOrigin: ctlLock.programs[PUMP]?.origin ?? null,
      exit: t4.status,
      relabelled: t4Report?.relabelled?.length,
      unbound: t4Report?.unbound?.length,
      stderrHead: (t4.stderr || '').slice(0, 300),
      note: 'this is the case the 2026-11-07 fix already covered: the pinned origin makes it `relabelled`, not `unbound`',
    },
    t5: {
      question: 'control — a store that declares NO origin (what every `sememe pull` produces)',
      exit: t5.status,
      lockPinsOrigin: t5Doc.programs[PUMP]?.origin ?? null,
      note: 'reporting this as unbound would fail every pull-only store: a false positive, not a guarantee',
    },
    verdict,
  };
}

const report = measure();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.verdict.violations.length ? 1 : 0);
