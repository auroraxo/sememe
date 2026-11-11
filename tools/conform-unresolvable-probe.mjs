#!/usr/bin/env node
// tools/conform-unresolvable-probe.mjs — run in EITHER tree (pre-fix via
// `git archive`, or this worktree). It asks the SAME question in both, and
// only the src/ under test differs:
//
//   When a transaction carries an instruction whose programIdIndex does NOT
//   resolve inside message.accountKeys, does the conformance gate
//     (a) refuse, or
//     (b) drop that instruction silently and report the rest?
//
// Cases:
//   droppedFill      the order-engine fill (the ONE instruction with a real
//                    disagreement) gets an unresolvable index.
//   droppedAppended  an EXTRA instruction with an unresolvable index appended
//                    to an otherwise intact transaction.
//   droppedCpi       the first CPI (innerInstructions) loses resolvability.
//   intactControl    untouched fixture transaction (must keep its verdict).
//   allDroppedControl every index unresolvable (the pre-existing refusal —
//                    its reason name must not move between the trees).
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
const ORDER_ENGINE = '2En5Y11SEAGLNmEezTuRUCwTyzyNReHaMbSnS5gjGsL1';

const baseTx = () => {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_TX, 'utf8'));
  return raw.result ?? raw;
};
const keyCount = (tx) => tx.transaction.message.accountKeys.length;

const variants = {
  droppedFill: () => {
    const tx = baseTx();
    tx.transaction.message.instructions[3].programIdIndex = keyCount(tx) + 86;
    return tx;
  },
  droppedAppended: () => {
    const tx = baseTx();
    tx.transaction.message.instructions.push({
      accounts: [0, 1],
      data: '3Bxs4X124TkQDWb9',
      programIdIndex: keyCount(tx) + 86,
      stackHeight: 1,
    });
    return tx;
  },
  droppedCpi: () => {
    const tx = baseTx();
    tx.meta.innerInstructions[0].instructions[0].programIdIndex = keyCount(tx) + 86;
    return tx;
  },
  intactControl: () => baseTx(),
  allDroppedControl: () => {
    const tx = baseTx();
    for (const instruction of tx.transaction.message.instructions) {
      instruction.programIdIndex = keyCount(tx) + 86;
    }
    tx.meta.innerInstructions = [];
    return tx;
  },
};

async function main() {
  const { checkTransaction } = await import(new URL(`file://${path.join(ROOT, 'src', 'conformance.mjs')}`).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-conform-unresolvable-probe-'));
  const cases = {};
  try {
    for (const [name, make] of Object.entries(variants)) {
      const tx = make();
      const total = tx.transaction.message.instructions.length
        + (tx.meta.innerInstructions ?? []).reduce((n, g) => n + (g.instructions?.length ?? 0), 0);
      let library;
      try {
        const report = await checkTransaction(tx, FIXTURE_STORE, {});
        library = {
          refused: false,
          reason: null,
          rows: report.rows.length,
          instructions: report.summary.instructions,
          droppedVisible: report.summary.instructions >= total
            || report.rows.some((r) => String(r.verdict).includes('unresolvable')),
          byVerdict: report.summary.byVerdict,
        };
      } catch (error) {
        library = {
          refused: true,
          reason: error?.reason ?? null,
          message: String(error?.message ?? error).slice(0, 200),
          rows: null,
          instructions: null,
          droppedVisible: true,
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
          refusalReason: /conformance refused: (\S+)/.test(both) ? RegExp.$1 : null,
        },
      };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({ cases }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(3);
});
