#!/usr/bin/env node
// tools/conform-filter-probe.mjs — DOES A FILTER THAT MATCHES NOTHING GET REFUSED?
//
// A byte-identical probe run in TWO trees (pre-fix, post-fix). It answers
// only observable questions about the tree it runs inside: it imports THAT
// tree's src/conformance.mjs and spawns THAT tree's bin/sememe.mjs against
// the committed fixture transaction and fixture store. Nothing here asserts a
// verdict about which tree is right — the tool that runs this derives the
// verdict from the two runs.
//
// Cases (all on test/fixtures/order-engine-conformance-tx.json):
//   filterMiss    --only <32-byte base58 program the tx never invokes>
//   filterGarbage --only <string that is not base58>
//   match         --only <program the tx invokes>
//   noFilter      (no --only)
//
// Per case the probe records: does the LIBRARY refuse (throw), the refusal
// reason, the CLI exit code, and — the defect's own signature — the CLI's
// `summary.instructions` when it printed a report at all.
//
// Exit codes: 0 the probe ran; 3 NO VERDICT (the tree could not be read).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const TX_PATH = path.join(ROOT, 'test', 'fixtures', 'order-engine-conformance-tx.json');
const STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');

const UNINVOKED = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'; // valid id, not in this tx
const INVOKED = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'; // in this tx

async function libraryCase(only) {
  const { checkTransaction } = await import(path.join(ROOT, 'src', 'conformance.mjs'));
  const envelope = JSON.parse(readFileSync(TX_PATH, 'utf8'));
  const tx = envelope.result ?? envelope;
  const options = only === undefined ? {} : { only: [only] };
  try {
    const report = await checkTransaction(tx, STORE, options);
    return { refused: false, reason: null, rows: report.rows.length, instructions: report.summary.instructions };
  } catch (error) {
    return {
      refused: true,
      reason: error?.reason ?? error?.name ?? 'unknown',
      rows: null,
      instructions: null,
    };
  }
}

function cliCase(only) {
  const args = [BIN, 'conform', TX_PATH, '--store', STORE];
  if (only !== undefined) args.push('--only', only);
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  let instructions = null;
  let rows = null;
  try {
    const report = JSON.parse(result.stdout);
    instructions = report?.summary?.instructions ?? null;
    rows = Array.isArray(report?.rows) ? report.rows.length : null;
  } catch {
    // no report printed (refusal goes to stderr) — that is a fact, not a failure
  }
  const reasonMatch = /conformance refused: ([a-z-]+)/.exec(result.stderr ?? '');
  return { exit: result.status, instructions, rows, refusalReason: reasonMatch ? reasonMatch[1] : null };
}

const [library, cli] = [await libraryCase, null]; // keep linters quiet about unused
void library;
void cli;

const cases = {};
for (const [name, only] of [
  ['filterMiss', UNINVOKED],
  ['filterGarbage', 'not-a-base58-value!'],
  ['match', INVOKED],
  ['noFilter', undefined],
]) {
  cases[name] = { library: await libraryCase(only), cli: cliCase(only) };
}

console.log(JSON.stringify({ cases }, null, 2));
