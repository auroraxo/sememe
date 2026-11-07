// sememe.lock — the fingerprint lockfile the README's contract promised and
// the tree never shipped.
//
// What this module is NOT: not distribution, not an update path, not a second
// acquisition channel. It records what a store ANSWERED with, so a project
// can commit one document that says "my decode calls answered with these
// fingerprints" and have CI refuse silent drift. The store reader
// (src/store-read.mjs) already refuses a tampered object on every read; the
// lock adds the cross-time check no single read can make: the store's answer
// is still THE answer it was pinned at.
//
// The document is canonical JSON with a trailing newline (the same
// serialization `pull`/`adopt` fingerprint their objects with), so diffs are
// stable and the file is reproducible from the store alone. Refusals are
// named, never guessed around:
//   lock-v1-parse       the file is not JSON
//   lock-v1-shape       the document is not a v1 lock (programs map etc.)
//   lock-v1-fingerprint a pinned fingerprint is not sha256:<64 hex>
// Violations checkLock reports (each with the program named):
//   drifted     the store answers the program with a DIFFERENT fingerprint
//   missing     the store has no verified receipt for a pinned program
//   unverified  the pinned object fails the store reader's own re-hash check
//   relabelled  a pinned or stored DECLARED origin changed after the fact —
//               the receipt says "declared" about bytes whose label no longer
//               matches what was pinned (see src/receipt-digest.mjs)
// Extra store programs are reported, never a violation: the lock pins
// minimums, not store equality — a pull that ADDS a program must not fail
// someone else's CI. writeLock refuses to write a lock over a store it cannot
// fully verify: every receipt is re-checked through the store reader first,
// so a lock is a snapshot of VERIFIED answers, never of filenames. The lock
// pins each program's DECLARED origin next to its fingerprint: the fingerprint
// binds the bytes, the origin pins the label the store answered with, and
// neither may change silently.

import { writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './canonical.mjs';
import { readVerified } from './store-read.mjs';
import { compareReceiptNames } from './receipt-order.mjs';

const LOCK_VERSION = 1;
const HEX64 = /^[a-f0-9]{64}$/;

/** The program a receipt filename belongs to. Base58 program ids contain no
 * `-`, so the first dash-terminated run is the program; the source label may
 * contain dashes, the fingerprint never does (it is the last segment). */
function programOfReceiptName(name) {
  return name.split('-')[0];
}

/** Newest-selection rule, identical to `findStoredIdl`: sort by the ONE
 * shared ordering (numeric slot, filename tiebreak), take last. A plain
 * string sort here would pin "99999999" over "123456789" — two answers from
 * one store, measured 2026-11-07 (test/slot-order-store.test.mjs O2). */
async function newestReceipt(storeDir, program) {
  const receipts = path.join(storeDir, 'receipts');
  const names = (await readdir(receipts)).filter((name) => name.startsWith(`${program}-`));
  if (!names.length) return null;
  names.sort(compareReceiptNames);
  return readVerified(storeDir, program, names[names.length - 1]);
}

/** Every receipt of `program`, re-checked through the store reader.
 *
 * Measured 2026-11-07 (this host): a store may hold SEVERAL receipts for one
 * program — a pull plus a published copy, or two published copies. `writeLock`
 * re-checked only the NEWEST of them, so a DAMAGED second copy was skipped in
 * silence: `sememe lock` exited 0 and `sememe verify` reported 0 violations
 * over a store whose union decode refused to decode. The README's claim
 * ("every receipt is re-checked through the store reader first, so a store the
 * reader refuses produces NO lock, never a lock over damage") was therefore
 * true of one receipt out of several.
 *
 * Every receipt is checked here, so a lock is a snapshot of VERIFIED answers
 * over the WHOLE store, not of the receipt that happened to sort last.
 *
 * ONE helper for BOTH lock paths on purpose: `writeLock` (refuse to write) and
 * `checkLock` (name the damage) must agree about what a clean store is. Two
 * separate loops is how the store ended up "locked clean" and "verified
 * damaged" in the same run. */
async function verifyEveryReceipt(storeDir, program, names) {
  for (const name of names) {
    try {
      await readVerified(storeDir, program, name);
    } catch (error) {
      // The failure KIND decides which bucket checkLock reports it in: a
      // rewritten declared origin is a relabel, not an unreadable object.
      return {
        ok: false,
        receipt: name,
        reason: String(error?.message ?? error).slice(0, 300),
        code: error?.code ?? null,
      };
    }
  }
  return { ok: true, receipt: null, reason: null, code: null };
}

/** Snapshot every verified receipt of `storeDir` into a lock document.
 * Returns the document; `outPath` receives exactly its canonical bytes. */
export async function writeLock(storeDir, outPath) {
  const receipts = path.join(storeDir, 'receipts');
  let names;
  try { names = await readdir(receipts); }
  catch (error) {
    if (error?.code === 'ENOENT') {
      throw Error(`no sememe store at ${storeDir}: run "sememe pull" first`);
    }
    throw error;
  }
  const programs = [...new Set(names.map(programOfReceiptName))].sort();
  const doc = { lockVersion: LOCK_VERSION, programs: {} };
  for (const program of programs) {
    // Full verification through the store reader: a tampered object or a
    // dangling receipt must fail the LOCK, not silently enter it — and that
    // holds for EVERY receipt of the program, not only the newest one.
    const candidates = names.filter((name) => name.startsWith(`${program}-`));
    const verdict = await verifyEveryReceipt(storeDir, program, candidates);
    if (!verdict.ok) {
      // Refuse the lock: a store the reader refuses must produce NO lock.
      throw Error(verdict.reason);
    }
    const { idl, receipt, receiptName } = await newestReceipt(storeDir, program);
    doc.programs[program] = {
      fingerprint: receipt.fingerprint,
      source: receipt.source ?? 'unknown',
      slot: receipt.slot ?? null,
      receipt: receiptName,
      instructions: Array.isArray(idl.instructions) ? idl.instructions.length : 0,
      // The DECLARED origin, pinned beside the fingerprint. Absent for an
      // on-chain receipt (it names no file) and for a legacy adopted receipt
      // without one; `null` never appears — a pinned origin is a string.
      ...(receipt.origin === undefined || receipt.origin === null ? {} : {
        origin: receipt.origin,
        originStatus: receipt.originStatus ?? 'declared',
      }),
    };
  }
  const bytes = Buffer.from(`${canonicalJson(doc)}\n`);
  if (outPath !== undefined && outPath !== null) {
    await writeFile(outPath, bytes);
  }
  return doc;
}

/** Parse and shape-check a lock document. Every failure names its reason. */
export async function readLock(lockPath) {
  let raw;
  try { raw = await readFile(lockPath, 'utf8'); }
  catch (error) {
    throw Error(`sememe lock file ${lockPath} is unreadable: ${String(error?.message ?? error).slice(0, 140)}`);
  }
  let doc;
  try { doc = JSON.parse(raw); }
  catch {
    throw Error(`sememe lock file ${lockPath} is not JSON (lock-v1-parse)`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw Error(`sememe lock file ${lockPath} is not a lock document (lock-v1-shape)`);
  }
  if (doc.lockVersion !== LOCK_VERSION) {
    throw Error(`sememe lock file ${lockPath} has unsupported lockVersion ${JSON.stringify(doc.lockVersion)} — expected ${LOCK_VERSION} (lock-v1-shape)`);
  }
  if (!doc.programs || typeof doc.programs !== 'object' || Array.isArray(doc.programs)) {
    throw Error(`sememe lock file ${lockPath} has no programs map (lock-v1-shape)`);
  }
  for (const [program, entry] of Object.entries(doc.programs)) {
    if (!entry || typeof entry !== 'object') {
      throw Error(`sememe lock file ${lockPath} pins ${program} with a non-object entry (lock-v1-shape)`);
    }
    const fingerprint = typeof entry.fingerprint === 'string' ? entry.fingerprint.replace(/^sha256:/, '') : '';
    if (!HEX64.test(fingerprint)) {
      throw Error(`sememe lock file ${lockPath} pins ${program} with a malformed fingerprint ${JSON.stringify(entry.fingerprint)} (lock-v1-fingerprint)`);
    }
    if (entry.origin !== undefined && typeof entry.origin !== 'string') {
      throw Error(`sememe lock file ${lockPath} pins ${program} with a malformed origin ${JSON.stringify(entry.origin)} (lock-v1-origin)`);
    }
  }
  return doc;
}

/** Re-check a store against a lock document. Returns the full report.
 * `mode: 'error'` (the CI-gate default) throws after the report is complete
 * when any violation exists; `mode: 'warn'` never throws on violations. */
export async function checkLock(storeDir, lockPath, { mode = 'error' } = {}) {
  const doc = await readLock(lockPath);
  const pinnedPrograms = Object.keys(doc.programs).sort();

  let receiptNames = [];
  try { receiptNames = (await readdir(path.join(storeDir, 'receipts'))); }
  catch (error) {
    if (error?.code === 'ENOENT') {
      throw Error(`no sememe store at ${storeDir}: run "sememe pull" first`);
    }
    throw error;
  }
  // The same ONE ordering the writer and both readers use, so "newest" means
  // the same receipt on every side of a lock comparison.
  receiptNames.sort(compareReceiptNames);
  const storePrograms = [...new Set(receiptNames.map(programOfReceiptName))].sort();

  const report = {
    lock: path.resolve(lockPath),
    store: path.resolve(storeDir),
    mode,
    pinned: pinnedPrograms.length,
    verified: [],
    drifted: [],
    missing: [],
    unverified: [],
    // A declared origin that is no longer the one that was pinned, or a
    // receipt whose own declared label no longer matches its digest.
    relabelled: [],
    extra: storePrograms.filter((program) => !doc.programs[program]),
  };

  for (const program of pinnedPrograms) {
    const pinnedFingerprint = doc.programs[program].fingerprint.replace(/^sha256:/, '');
    const candidates = receiptNames.filter((name) => name.startsWith(`${program}-`));
    if (!candidates.length) {
      report.missing.push(program);
      continue;
    }
    const newest = candidates[candidates.length - 1];
    // Every receipt of this program is re-checked, not only the newest: a
    // damaged SECOND copy is a damaged store, and reporting it as clean is the
    // green lie this gate exists to prevent. The SAME helper the writer uses,
    // so "lock" and "verify" cannot disagree about the store.
    const verdict = await verifyEveryReceipt(storeDir, program, candidates);
    if (!verdict.ok) {
      if (verdict.code === 'receipt-relabelled') {
        // The declared origin in the receipt no longer matches its own digest:
        // the label was rewritten after the receipt was written. Reported as
        // its own violation kind so a caller can see that the BYTES are fine
        // and the PROVENANCE claim is not.
        report.relabelled.push({ program, receipt: verdict.receipt, reason: verdict.reason, scope: 'receipt' });
      } else {
        report.unverified.push({ program, receipt: verdict.receipt, reason: verdict.reason });
      }
      continue;
    }
    let source;
    try {
      source = await readVerified(storeDir, program, newest);
    } catch (error) {
      if (error?.code === 'receipt-relabelled') {
        report.relabelled.push({
          program,
          receipt: newest,
          reason: String(error?.message ?? error).slice(0, 300),
          scope: 'receipt',
        });
      } else {
        report.unverified.push({ program, receipt: newest, reason: String(error?.message ?? error).slice(0, 200) });
      }
      continue;
    }
    const storeFingerprint = source.receipt.fingerprint.replace(/^sha256:/, '');
    if (storeFingerprint !== pinnedFingerprint) {
      report.drifted.push({
        program,
        pinned: `sha256:${pinnedFingerprint}`,
        store: `sha256:${storeFingerprint}`,
        storeReceipt: newest,
      });
      continue;
    }
    // Fingerprint matches: now the DECLARED ORIGIN must still be the pinned
    // one. The receipt's own digests catch an edited receipt; this catches a
    // receipt that was rewritten AND re-digested after the lock was written —
    // the layer a self-digest alone cannot cover, because the attacker holds
    // the same hashing function.
    const pinnedOrigin = doc.programs[program].origin;
    if (typeof pinnedOrigin === 'string') {
      const storeOrigin = source.receipt.origin ?? null;
      if (storeOrigin !== pinnedOrigin) {
        report.relabelled.push({
          program,
          receipt: newest,
          pinned: pinnedOrigin,
          store: storeOrigin,
          reason: `the store no longer declares origin ${JSON.stringify(pinnedOrigin)} for ${program} — the store answers ${storeOrigin === null ? 'no origin' : JSON.stringify(storeOrigin)}`,
          scope: 'lock',
        });
        continue;
      }
    }
    report.verified.push(program);
  }

  const violations = report.drifted.length + report.missing.length
    + report.unverified.length + report.relabelled.length;
  report.violations = violations;
  if (mode === 'error' && violations > 0) {
    const parts = [];
    if (report.drifted.length) {
      parts.push(`drifted: ${report.drifted.map((d) => `${d.program} pinned ${d.pinned} vs store ${d.store}`).join('; ')}`);
    }
    if (report.missing.length) parts.push(`missing: ${report.missing.join(', ')}`);
    if (report.unverified.length) parts.push(`unverified: ${report.unverified.map((u) => u.program).join(', ')}`);
    if (report.relabelled.length) {
      parts.push(`relabelled (declared origin changed): ${report.relabelled.map((r) => r.program).join(', ')}`);
    }
    throw Error(`store does not match sememe.lock (${report.drifted.length} drifted, ${report.missing.length} missing, ${report.unverified.length} unverified, ${report.relabelled.length} relabelled) — ${parts.join(' | ')}`);
  }
  return report;
}
