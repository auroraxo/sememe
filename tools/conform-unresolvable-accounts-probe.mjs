#!/usr/bin/env node
// tools/conform-unresolvable-accounts-probe.mjs — run in EITHER tree
// (pre-fix via `git archive`, or this worktree). It asks the SAME question
// in both, and only the src/ under test differs:
//
//   When a transaction carries an instruction whose ACCOUNT list contains a
//   reference that does not resolve inside the canonical key list, does the
//   conformance gate
//     (a) refuse, or
//     (b) fold the position into a null row and keep reporting?
//
// Cases:
//   droppedExtraSigner  the order-engine fill's ONE signing extra account
//                       (the real disagreement) gets an out-of-range index.
//                       Pre-fix: `remaining-accounts`, exit 0 — the
//                       disagreement HIDDEN.
//   droppedFillAll      the whole fill accounts list unresolvable.
//   droppedCpi          the first CPI instruction loses an account index.
//   parsedObjectAccounts the WHOLE transaction in `jsonParsed` object shape
//                       (the encoding the file's header says it does not
//                       model) — pre-fix: every account became a null.
//   intactControl       untouched fixture transaction (must keep exit 1
//                       with undeclared-signing-account in BOTH trees).
//   emptyAccountsControl  an instruction with an EMPTY accounts list — legal,
//                       must stay unrefused in both trees (over-refusal
//                       detector: it turns red if the fix refuses emptiness).
//
// Reads fixtures from the tree it runs in. JSON on stdout.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');
const FIXTURE_STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled');
const FIXTURE_TX = path.join(ROOT, 'test', 'fixtures', 'order-engine-conformance-tx.json');

const baseTx = () => {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_TX, 'utf8'));
  return raw.result ?? raw;
};
const keyCount = (tx) => tx.transaction.message.accountKeys.length;

const variants = {
  droppedExtraSigner: () => {
    const tx = baseTx();
    tx.transaction.message.instructions[3].accounts[11] = keyCount(tx) + 86;
    return tx;
  },
  droppedFillAll: () => {
    const tx = baseTx();
    tx.transaction.message.instructions[3].accounts
      = tx.transaction.message.instructions[3].accounts.map(() => keyCount(tx) + 86);
    return tx;
  },
  droppedCpi: () => {
    const tx = baseTx();
    const group = tx.meta.innerInstructions[0];
    group.instructions[1].accounts = [group.instructions[1].accounts[0], keyCount(tx) + 3];
    return tx;
  },
  parsedObjectAccounts: () => {
    const tx = baseTx();
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k?.pubkey));
    const n = tx.transaction.message.header.numRequiredSignatures;
    for (const instruction of tx.transaction.message.instructions) {
      instruction.accounts = instruction.accounts.map((i) => ({
        pubkey: keys[i], signer: i < n, writable: true,
      }));
    }
    return tx;
  },
  intactControl: () => baseTx(),
  emptyAccountsControl: () => {
    const tx = baseTx();
    for (const instruction of tx.transaction.message.instructions) instruction.accounts = [];
    tx.meta.innerInstructions = [];
    return tx;
  },
};

async function main() {
  const { checkTransaction } = await import(new URL(`file://${path.join(ROOT, 'src', 'conformance.mjs')}`).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-conform-accounts-probe-'));
  const cases = {};
  try {
    for (const [name, make] of Object.entries(variants)) {
      const tx = make();
      const total = tx.transaction.message.instructions.length
        + (tx.meta.innerInstructions ?? []).reduce((n, g) => n + (g.instructions?.length ?? 0), 0);
      let library;
      try {
        const report = await checkTransaction(tx, FIXTURE_STORE, {});
        const fill = report.rows.find((row) => row.instruction === 'fill') ?? null;
        library = {
          refused: false,
          reason: null,
          rows: report.rows.length,
          instructions: report.summary.instructions,
          fillVerdict: fill ? fill.verdict : null,
          unknownSignerPositions: fill ? (fill.unknownSigner ?? []).length : null,
          byVerdict: report.summary.byVerdict,
        };
      } catch (error) {
        library = {
          refused: true,
          reason: error?.reason ?? null,
          message: String(error?.message ?? error).slice(0, 300),
          rows: null,
          instructions: null,
          fillVerdict: null,
          unknownSignerPositions: null,
          byVerdict: null,
        };
      }
      const file = path.join(dir, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify({ result: tx }));
      const cli = spawnSync(
        process.execPath,
        [BIN, 'conform', file, '--store', FIXTURE_STORE],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      );
      let parsed = null;
      try { parsed = JSON.parse(cli.stdout); } catch { parsed = null; }
      const both = `${cli.stderr ?? ''}${cli.stdout ?? ''}`;
      cases[name] = {
        library,
        transactionInstructionCount: total,
        cli: {
          exit: cli.status,
          instructions: parsed?.summary?.instructions ?? null,
          rows: Array.isArray(parsed?.rows) ? parsed.rows.length : null,
          byVerdict: parsed?.summary?.byVerdict ?? null,
          refusalReason: /instruction-account-index-unresolvable/.test(both)
            ? 'instruction-account-index-unresolvable'
            : (/conformance refused: ([a-z-]+)/.exec(both)?.[1] ?? null),
        },
      };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ root: ROOT, cases }, null, 2));
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
