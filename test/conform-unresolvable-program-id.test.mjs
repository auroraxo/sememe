// test/conform-unresolvable-program-id.test.mjs — AN INSTRUCTION WHOSE
// PROGRAM ID CANNOT BE RESOLVED MUST NOT VANISH FROM THE CONFORMANCE GATE.
//
// MEASURED (2026-11-11, this host, pre-fix tree 94aa00b = the published
// v0.4.15, from committed fixtures — no network):
//
// `sememe conform <tx.json> --store <dir>` resolves an instruction's program
// either from `instruction.programId` or by INDEX into the canonical key
// list (`instruction.programIdIndex`). An index out of range, or a missing
// value, resolves to null — and src/conformance.mjs then did:
//
//     for (const instruction of instructions) {
//       if (!instruction.programId) continue;   // <-- NO row, NO count, NO refusal
//
// The dropped instruction disappears from `rows`, from
// `summary.instructions`, and from every verdict. The file's OWN header
// states the rule — "an unknown shape must never be reported as a clean
// bill of health" — and the code already refuses when NO instruction
// resolves (`transaction-has-no-resolvable-program-id`). The defect is the
// middle case: SOME resolve, SOME do not.
//
// THE WORST FACE (hand-measured on the order-engine fixture): the fill
// instruction (the ONE instruction with a real disagreement) gets an
// unresolvable programIdIndex, and the gate:
//     pre-fix:  rows 11 of a 12-instruction transaction,
//               byVerdict {no-stored-interface: 11}, EXIT 0
//     control:  the SAME transaction with an intact index exits 1 with
//               undeclared-signing-account
// The disagreement did not just go unchecked — it was HID, and the report
// looked like a complete run over the transaction it was given.
//
// THE CONTRACT:
//   U1  a transaction where SOME instructions resolve and SOME do not is a
//       REFUSAL, never a partial report: reason `instruction-program-id-
//       unresolvable` — the gate cannot claim to have checked the
//       transaction it was handed.
//   U2  the refusal applies to the UNFILTERED path too (not only --only).
//   U3  the CLI exits 1 over the dropped shape and prints NO verdict-carrying
//       report (pre-fix: exit 0 over 11 of 12 instructions).
//   U4  a CPI instruction (meta.innerInstructions) with an unresolvable
//       index is refused, not silently dropped from the inner set.
//   U5  the refusal detail names the OFFENDING POSITIONS and the index
//       values, so the caller can find the instruction without re-reading
//       the file by hand.
//   U6  the harm itself is pinned: pre-fix, breaking the fill's index
//       removed the disagreement from the report; post-fix it refuses
//       instead (a partial report must never replace a real disagreement).
//
// GUARDS (expected to pass on BOTH trees — they are the false-positive
// guards, not evidence of the fix):
//   G1  an INTACT store + INTACT transaction still reports the real
//       disagreement (undeclared-signing-account) with no refusal.
//   G2  the ALL-unresolvable case keeps its EXISTING reason
//       (`transaction-has-no-resolvable-program-id`) — the fix targets the
//       silent partial drop, it must not rewrite the refusal that already
//       refused.
//   G3  the direct `programId` (string) shape resolves as before and is NOT
//       refused.
//   G4  an intact store that simply does not HOLD a program still reports
//       honest `no-stored-interface` rows over a fully resolvable
//       transaction — an acquisition gap is not a shape defect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTransaction, ConformanceRefusal } from '../src/conformance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');
const FIXTURE_TX = path.join(HERE, 'fixtures', 'order-engine-conformance-tx.json');
const FIXTURE_STORE = path.join(HERE, 'fixtures', 'traffic-sample-store-2026-11-04-pulled');

const ORDER_ENGINE = '2En5Y11SEAGLNmEezTuRUCwTyzyNReHaMbSnS5gjGsL1';

const loadTx = () => {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_TX, 'utf8'));
  return raw.result ?? raw;
};

const KEY_COUNT = () => loadTx().transaction.message.accountKeys.length;

/** The SAME transaction with the FILL instruction's programIdIndex pushed
 * past the end of the key list: the one instruction this gate exists to
 * check becomes unresolvable, while every other instruction stays whole. */
function droppedFillTx() {
  const tx = loadTx();
  const fill = tx.transaction.message.instructions[3];
  assert.equal(fill.programIdIndex, 12, 'precondition: fixture instruction #3 is the order-engine fill');
  fill.programIdIndex = KEY_COUNT() + 86;
  return tx;
}

/** A transaction whose FIRST inner (CPI) instruction carries an
 * unresolvable index; top level untouched. */
function droppedCpiTx() {
  const tx = loadTx();
  tx.meta.innerInstructions[0].instructions[0].programIdIndex = KEY_COUNT() + 86;
  return tx;
}

/** A transaction where NO instruction resolves — the case the pre-fix code
 * ALREADY refused, with its own reason. */
function allDroppedTx() {
  const tx = loadTx();
  for (const instruction of tx.transaction.message.instructions) instruction.programIdIndex = KEY_COUNT() + 86;
  tx.meta.innerInstructions = [];
  return tx;
}

/** A fully resolvable transaction using the DIRECT `programId` shape the
 * code accepts as an alternative to an index. */
function directProgramIdTx() {
  const tx = loadTx();
  for (const instruction of tx.transaction.message.instructions) {
    instruction.programId = tx.transaction.message.accountKeys[instruction.programIdIndex];
  }
  return tx;
}

const writeTxFile = (tx) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-conform-unresolvable-'));
  const file = path.join(dir, 'tx.json');
  fs.writeFileSync(file, JSON.stringify({ result: tx }));
  return file;
};

// ---------------------------------------------------------------------------
// Defect cases: U1 - U6 (red on the pre-fix tree)
// ---------------------------------------------------------------------------

test('U1: a transaction with SOME unresolvable instructions is a refusal, not a partial report', async () => {
  await assert.rejects(
    () => checkTransaction(droppedFillTx(), FIXTURE_STORE, { only: [ORDER_ENGINE] }),
    (error) => {
      assert.ok(error instanceof ConformanceRefusal,
        `expected ConformanceRefusal, got ${error?.name}: ${error?.message}`);
      assert.equal(error.reason, 'instruction-program-id-unresolvable',
        `the refusal must be named instruction-program-id-unresolvable, got: ${error.reason}`);
      return true;
    },
  );
});

test('U2: the unfiltered path refuses too (not only --only)', async () => {
  await assert.rejects(
    () => checkTransaction(droppedFillTx(), FIXTURE_STORE, {}),
    (error) => error instanceof ConformanceRefusal && error.reason === 'instruction-program-id-unresolvable',
  );
});

test('U3: the CLI exits 1 over the dropped shape and prints no verdict-carrying report', () => {
  const file = writeTxFile(droppedFillTx());
  try {
    const result = spawnSync(
      process.execPath,
      [BIN, 'conform', file, '--store', FIXTURE_STORE],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(result.status, 1,
      `expected exit 1 over an unresolvable instruction, got ${result.status} (stdout: ${String(result.stdout).slice(0, 160)})`);
    assert.doesNotMatch(result.stdout, /"verdict"/,
      'a refused shape must not produce a verdict-carrying report');
    assert.match(`${result.stderr}`, /instruction-program-id-unresolvable/,
      'the refusal reason must be visible on the error channel');
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('U4: a CPI instruction with an unresolvable index is refused, not dropped', async () => {
  await assert.rejects(
    () => checkTransaction(droppedCpiTx(), FIXTURE_STORE, {}),
    (error) => error instanceof ConformanceRefusal && error.reason === 'instruction-program-id-unresolvable',
    'inner (CPI) instructions are part of the transaction — an unresolved one cannot silently shrink the report',
  );
});

test('U5: the refusal names the offending positions and index values', async () => {
  const tx = droppedFillTx();
  await assert.rejects(
    () => checkTransaction(tx, FIXTURE_STORE, {}),
    (error) => {
      assert.ok(error instanceof ConformanceRefusal);
      assert.match(error.detail, /\b3\b/,
        `the refusal must name the offending position (top-level #3), got: ${error.detail}`);
      assert.match(error.detail, new RegExp(String(tx.transaction.message.instructions[3].programIdIndex)),
        `the refusal must name the bad index value, got: ${error.detail}`);
      return true;
    },
  );
});

test('U6: THE HARM — the disagreement cannot be hidden by an unresolvable index', async () => {
  // Control: the intact fill disagrees (this is the real finding).
  const intact = await checkTransaction(loadTx(), FIXTURE_STORE, { only: [ORDER_ENGINE] });
  const disagreement = (intact.summary.byVerdict ?? {})['undeclared-signing-account'] ?? 0;
  assert.ok(disagreement > 0, 'precondition: the intact fixture must carry the real disagreement');
  // The defect used to make that disagreement UNMEASURABLE and exit green.
  // Post-fix: the gate refuses instead of reporting a transaction subset.
  await assert.rejects(
    () => checkTransaction(droppedFillTx(), FIXTURE_STORE, {}),
    (error) => error instanceof ConformanceRefusal && error.reason === 'instruction-program-id-unresolvable',
  );
});

// ---------------------------------------------------------------------------
// Guards: G1 - G4 (green on BOTH trees — false-positive guards)
// ---------------------------------------------------------------------------

test('G1: GUARD — an intact transaction over an intact store keeps its real disagreement', async () => {
  const report = await checkTransaction(loadTx(), FIXTURE_STORE, { only: [ORDER_ENGINE] });
  assert.ok(report.rows.some((row) => (row.violations ?? []).some((v) => v.kind === 'undeclared-signing-account')),
    'the documented disagreement must survive untouched');
});

test('G2: GUARD — the ALL-unresolvable case keeps its existing reason', async () => {
  await assert.rejects(
    () => checkTransaction(allDroppedTx(), FIXTURE_STORE, {}),
    (error) => {
      assert.ok(error instanceof ConformanceRefusal);
      assert.equal(error.reason, 'transaction-has-no-resolvable-program-id',
        'the fix must not rewrite the refusal that already refused');
      return true;
    },
  );
});

test('G3: GUARD — the direct programId (string) shape resolves and is NOT refused', async () => {
  const report = await checkTransaction(directProgramIdTx(), FIXTURE_STORE, {});
  assert.ok(report.rows.length > 0, 'direct program ids must still produce a full report');
});

test('G4: GUARD — an acquisition gap on a resolvable transaction is still no-stored-interface, not a refusal', async () => {
  const report = await checkTransaction(loadTx(), FIXTURE_STORE, {});
  const gaps = report.rows.filter((row) => row.verdict === 'no-stored-interface');
  assert.ok(gaps.length > 0, 'the intact store must still report honest gap rows');
});
