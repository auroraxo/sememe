// test/conform-unresolvable-accounts.test.mjs — AN ACCOUNT REFERENCE THE
// GATE CANNOT RESOLVE MUST REFUSE, NOT DECODE INTO A GREEN ROW.
//
// MEASURED (2026-11-11, this host, pre-fix tree 7b30c68 = the published
// v0.4.16, from committed fixtures — no network):
//
// `sememe conform <tx.json> --store <dir>` resolves an instruction's
// accounts by INDEX into the canonical key list
// (`src/conformance.mjs transactionInstructions`):
//
//     const key = keys[index];
//     return key
//       ? { address: key.address, signer: key.signer, writable: key.writable }
//       : { address: null, signer: null, writable: null };   // <-- NO refusal
//
// An index past the end of the list, a negative index, a non-integer entry,
// or an object entry (the `jsonParsed` encoding this file's OWN header says
// it does not model) all land in that null face. `checkAccountList` then
// treats the position as "signer unknown" — a note, never a violation — and
// the CLI exits 0.
//
// THE WORST FACE (hand-measured on the order-engine fixture): the fill
// instruction carries the transaction's ONE real disagreement — an undeclared
// SIGNING extra account at position 11. Replacing exactly that index with an
// out-of-range value:
//     intact:  verdict undeclared-signing-account, EXIT 1
//     broken:  verdict remaining-accounts,        EXIT 0
// The disagreement is not just unchecked — it is HIDDEN behind a report that
// looks complete. Same class as the unresolvable programIdIndex refused one
// pulse ago (2026-11-11, v0.4.16), one level over: not the program reference,
// the ACCOUNT reference.
//
// THE CONTRACT:
//   A1  a top-level instruction whose accounts list contains an index past
//       the end of the key list is a REFUSAL: reason
//       `instruction-account-index-unresolvable`, before the store is read.
//   A2  the worst face is pinned: breaking the ONE signing extra's index
//       must refuse — it must not downgrade `undeclared-signing-account`
//       to `remaining-accounts` and exit 0.
//   A3  a CPI instruction (`meta.innerInstructions`) with an unresolvable
//       account index is refused too — an inner instruction is part of the
//       transaction.
//   A4  a non-integer account entry — including the `jsonParsed` OBJECT
//       shape this file declares it does not handle — is refused by name,
//       not silently mapped to a null key.
//   A5  the refusal detail names the OFFENDING INSTRUCTIONS (top-level #n /
//       CPI of top-level #n at position p), the account POSITION, and the
//       raw value, so the caller can find it without re-reading the file.
//   A6  the CLI exits 1 over the broken shape and prints NO verdict-carrying
//       report (pre-fix: exit 0 over the hidden disagreement).
//
// GUARDS (pass on BOTH trees — false-positive guards, not evidence):
//   G1  the INTACT fixture keeps its real disagreement
//       (undeclared-signing-account, exit 1) and is NOT refused.
//   G2  an instruction with an EMPTY accounts list is legal (ComputeBudget
//       rows) — emptiness is not unresolvability.
//   G3  indices into the LOADED (address-lookup-table) range stay legal —
//       `keys` covers static + loadedWritable + loadedReadonly.
//   G4  the existing program-id refusal keeps its reason and its order: a
//       transaction with an unresolvable PROGRAM index refuses with
//       `instruction-program-id-unresolvable`, even when its accounts are
//       also broken — the older refusal must not be swallowed by the new one.
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

const REASON = 'instruction-account-index-unresolvable';

const loadTx = () => {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_TX, 'utf8'));
  return raw.result ?? raw;
};

// The fixture's key count: 15 static, no loaded addresses.
const KEY_COUNT = () => loadTx().transaction.message.accountKeys.length;

/** The fill instruction: top-level #3, 12 observed accounts vs 11 declared,
 * the LAST one a signer — the transaction's only real disagreement. */
function fillInstruction(tx) {
  const fill = tx.transaction.message.instructions[3];
  assert.equal(fill.programIdIndex, 12, 'precondition: fixture instruction #3 is the order-engine fill');
  assert.deepEqual(fill.accounts, [2, 1, 12, 5, 4, 6, 9, 10, 14, 11, 7, 0],
    'precondition: the fill carries 12 account indices');
  return fill;
}

/** A2's face: ONLY the signing extra (position 11) becomes unresolvable. */
function brokenExtraSignerTx() {
  const tx = loadTx();
  fillInstruction(tx).accounts[11] = KEY_COUNT() + 86;
  return tx;
}

/** A1: the whole fill accounts list unresolvable. */
function brokenFillAllTx() {
  const tx = loadTx();
  fillInstruction(tx).accounts = fillInstruction(tx).accounts.map(() => KEY_COUNT() + 86);
  return tx;
}

/** A1: a single out-of-range index in a non-fill top-level instruction. */
function brokenTopLevelTx() {
  const tx = loadTx();
  const instr = tx.transaction.message.instructions[4];
  assert.equal(instr.programIdIndex, 11, 'precondition: fixture instruction #4 is the token burn');
  instr.accounts = [instr.accounts[0], instr.accounts[1], KEY_COUNT() + 3, instr.accounts[3]];
  return tx;
}

/** A3: the FIRST CPI instruction carries an out-of-range account index. */
function brokenCpiTx() {
  const tx = loadTx();
  const group = tx.meta.innerInstructions[0];
  group.instructions[1].accounts = [group.instructions[1].accounts[0], KEY_COUNT() + 3];
  return tx;
}

/** A4: jsonParsed-shaped ACCOUNT OBJECTS instead of indices — the encoding
 * this file's header explicitly says it does not model. */
function parsedObjectAccountsTx() {
  const tx = loadTx();
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k?.pubkey));
  for (const instruction of tx.transaction.message.instructions) {
    instruction.accounts = instruction.accounts.map((i) => ({
      pubkey: keys[i], signer: i < tx.transaction.message.header.numRequiredSignatures, writable: true,
    }));
  }
  return tx;
}

/** G4: unresolvable PROGRAM index (the older refusal) with intact accounts. */
function brokenProgramIdTx() {
  const tx = loadTx();
  fillInstruction(tx).programIdIndex = KEY_COUNT() + 86;
  return tx;
}

const writeTxFile = (tx) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-conform-accounts-'));
  const file = path.join(dir, 'tx.json');
  fs.writeFileSync(file, JSON.stringify({ result: tx }));
  return file;
};

const expectRefusal = async (tx, testId) => {
  await assert.rejects(
    () => checkTransaction(tx, FIXTURE_STORE, {}),
    (error) => {
      assert.ok(error instanceof ConformanceRefusal,
        `${testId}: expected ConformanceRefusal, got ${error?.name}: ${error?.message}`);
      assert.equal(error.reason, REASON, `${testId}: refusal reason`);
      return true;
    },
    `${testId}: an unresolvable account reference must refuse`,
  );
};

// ---------------------------------------------------------------------------
// Defect cases A1–A6 (red on the pre-fix tree)
// ---------------------------------------------------------------------------

test('A1: an out-of-range account index in a top-level instruction is a refusal, not a null row', async () => {
  await expectRefusal(brokenFillAllTx(), 'A1-fill');
  await expectRefusal(brokenTopLevelTx(), 'A1-other');
});

test('A2: hiding the ONE real disagreement behind an unresolvable extra must refuse', async () => {
  // The exact harm: the signing extra's index is broken, and pre-fix the
  // gate downgraded `undeclared-signing-account` to `remaining-accounts`.
  await expectRefusal(brokenExtraSignerTx(), 'A2');
  // And it must refuse BEFORE the store is consulted: a store that holds
  // nothing for the program still refuses the shape, never reports rows.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-conform-accounts-empty-'));
  await assert.rejects(
    () => checkTransaction(brokenExtraSignerTx(), emptyDir, {}),
    (error) => error instanceof ConformanceRefusal && error.reason === REASON,
    'A2: the refusal is about the transaction shape, not the store',
  );
});

test('A3: a CPI instruction with an unresolvable account index is refused too', async () => {
  await expectRefusal(brokenCpiTx(), 'A3');
});

test('A4: object-shaped accounts (jsonParsed) are refused by name, not mapped to null', async () => {
  await expectRefusal(parsedObjectAccountsTx(), 'A4');
});

test('A5: the refusal names the offending instructions, positions, and raw values', async () => {
  await assert.rejects(
    () => checkTransaction(brokenExtraSignerTx(), FIXTURE_STORE, {}),
    (error) => {
      const detail = String(error?.message ?? '');
      assert.match(detail, /#3/, `A5: names the offending top-level instruction: ${detail}`);
      assert.match(detail, /position 11/, `A5: names the account position: ${detail}`);
      assert.match(detail, /101/, `A5: carries the raw offending value (15+86=101): ${detail}`);
      return true;
    },
  );
  const cpi = await checkRefusal(brokenCpiTx());
  assert.match(cpi, /CPI of top-level/, `A5: CPI offenders are located: ${cpi}`);
});

async function checkRefusal(tx) {
  try {
    await checkTransaction(tx, FIXTURE_STORE, {});
    assert.fail('expected a refusal');
  } catch (error) {
    if (error instanceof ConformanceRefusal) return String(error.message);
    throw error;
  }
}

test('A6: the CLI exits 1 over the broken shape and prints no decision-carrying report', () => {
  const file = writeTxFile(brokenExtraSignerTx());
  const cli = spawnSync(process.execPath, [BIN, 'conform', file, '--store', FIXTURE_STORE], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(cli.status, 1, `A6: exit code (stderr: ${String(cli.stderr).slice(0, 200)})`);
  let report = null;
  try { report = JSON.parse(cli.stdout); } catch { report = null; }
  if (report && Array.isArray(report.rows)) {
    assert.fail(`A6: the CLI printed a verdict-carrying report over a refused shape: ${JSON.stringify(report.summary)}`);
  }
  assert.match(`${cli.stderr}${cli.stdout}`, new RegExp(REASON), 'A6: the refusal reason is printed');
});

// ---------------------------------------------------------------------------
// Guards G1–G4 (green on BOTH trees)
// ---------------------------------------------------------------------------

test('G1: the intact fixture keeps its real disagreement and is NOT refused', async () => {
  const report = await checkTransaction(loadTx(), FIXTURE_STORE, {});
  const fill = report.rows.find((row) => row.instruction === 'fill');
  assert.equal(fill.verdict, 'undeclared-signing-account', 'G1: disagreement intact');
  const file = writeTxFile(loadTx());
  const cli = spawnSync(process.execPath, [BIN, 'conform', file, '--store', FIXTURE_STORE], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(cli.status, 1, 'G1: the real disagreement still exits 1');
});

test('G2: an empty accounts list is legal and never refused', async () => {
  const tx = loadTx();
  for (const instruction of tx.transaction.message.instructions) instruction.accounts = [];
  tx.meta.innerInstructions = [];
  // Unresolvable program ids must not hide behind this guard — the fixture
  // programs stay intact; only the account lists are emptied.
  const report = await checkTransaction(tx, FIXTURE_STORE, {});
  assert.ok(report.rows.length >= 5, 'G2: empty lists still produce honest rows');
});

test('G3: indices into the loaded (ALT) range stay legal', async () => {
  const tx = loadTx();
  tx.meta.loadedAddresses = { writable: ['LoAdEdWrItAbLeAcCoUnTtEsTuBiD111111111111111'], readonly: [] };
  const keyCount = KEY_COUNT();
  fillInstruction(tx).accounts = fillInstruction(tx).accounts.map((i) => (i === 0 ? keyCount : i));
  const report = await checkTransaction(tx, FIXTURE_STORE, {});
  const fill = report.rows.find((row) => row.instruction === 'fill');
  assert.ok(fill, 'G3: the fill is still reported');
  assert.notEqual(String(fill.verdict), REASON, 'G3: a loaded-range index is resolvable');
});

test('G4: the older program-id refusal keeps its reason even beside broken accounts', async () => {
  const tx = brokenProgramIdTx();
  tx.transaction.message.instructions[4].accounts = [999];
  await assert.rejects(
    () => checkTransaction(tx, FIXTURE_STORE, {}),
    (error) => {
      assert.ok(error instanceof ConformanceRefusal);
      assert.equal(error.reason, 'instruction-program-id-unresolvable',
        'G4: the program-id refusal stands, untouched by the new one');
      return true;
    },
  );
});
