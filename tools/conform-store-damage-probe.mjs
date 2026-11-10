#!/usr/bin/env node
// tools/conform-store-damage-probe.mjs — DOES THE CONFORMANCE GATE REPORT AS
// CLEAN A STORE IT COULD NOT READ?
//
// A byte-identical probe run in TWO trees (pre-fix, post-fix). It answers
// only observable questions about the tree it runs inside: it imports THAT
// tree's src/conformance.mjs and spawns THAT tree's bin/sememe.mjs against
// the committed fixture transaction and stores this probe BUILDs in a temp
// directory (both trees get the same store bytes, because the damage is
// produced here from the committed fixture store). Nothing here asserts a
// verdict about which tree is right — the tool that runs this derives the
// verdict from the two runs.
//
// Cases (all on test/fixtures/order-engine-conformance-tx.json, which
// invokes order-engine 2En5Y11SEAGLNmEezTuRUCwTyzyNReHaMbSnS5gjGsL1):
//   damagedReceipt  a receipt whose fingerprint no longer matches its object
//                   — the damage the store reader already refuses on decode
//   missingStore    a --store directory that does not exist
//   noReceiptsDir   a --store directory with objects/ but no receipts/
//   honestGap       the INTACT store, --only <program the store does not hold>
//   intactViolation the INTACT store, --only <program it holds and which
//                   genuinely disagrees (undeclared signing account)
//
// The defect's own signature: `cliExitGreenWithNoReader` — exit 0 on a
// store the reader refused. `honestGap` and `intactViolation` are the
// controls: they must behave the SAME in both trees (a fix that refuses
// genuine absences or swallows real disagreements is a regression, and the
// measurement would say so).
//
// Exit codes: 0 the probe ran; 3 NO VERDICT (the tree could not be read).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const TX_PATH = path.join(ROOT, 'test', 'fixtures', 'order-engine-conformance-tx.json');
const STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled');
const BIN = path.join(ROOT, 'bin', 'sememe.mjs');

const ORDER_ENGINE = '2En5Y11SEAGLNmEezTuRUCwTyzyNReHaMbSnS5gjGsL1'; // held + disagrees
const TOKEN_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'; // NOT held: an honest gap

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-conform-damage-probe-'));

/** The fixture store with the order-engine receipt's fingerprint tampered —
 *  exactly the damage `sememe decode` refuses on this repo. */
function tamperedStore() {
  const store = path.join(tmpRoot, 'damaged');
  fs.cpSync(STORE, store, { recursive: true });
  const dir = path.join(store, 'receipts');
  const file = fs.readdirSync(dir).find((name) => name.startsWith(`${ORDER_ENGINE}-`));
  if (!file) { console.error('the fixture store must hold an order-engine receipt'); process.exit(3); }
  const target = path.join(dir, file);
  const receipt = JSON.parse(readFileSync(target, 'utf8'));
  receipt.fingerprint = `sha256:${'0'.repeat(64)}`;
  fs.writeFileSync(target, JSON.stringify(receipt));
  return store;
}

/** A store directory with objects/ but no receipts/. */
function storeWithoutReceipts() {
  const store = path.join(tmpRoot, 'noreceipts');
  fs.mkdirSync(path.join(store, 'objects'), { recursive: true });
  return store;
}

async function libraryCase(store, only) {
  const { checkTransaction } = await import(path.join(ROOT, 'src', 'conformance.mjs'));
  const envelope = JSON.parse(readFileSync(TX_PATH, 'utf8'));
  const tx = envelope.result ?? envelope;
  const options = only === undefined ? {} : { only: [only] };
  try {
    const report = await checkTransaction(tx, store, options);
    return {
      refused: false,
      reason: null,
      rows: report.rows.length,
      instructions: report.summary.instructions,
      byVerdict: report.summary.byVerdict,
      disagreementKinds: Object.keys(report.summary.byVerdict ?? {})
        .filter((kind) => !['conforms', 'no-stored-interface', 'unknown-instruction',
          'unknown-discriminator', 'remaining-accounts', 'short-optional-tail'].includes(kind)),
    };
  } catch (error) {
    return {
      refused: true,
      reason: error?.reason ?? error?.name ?? 'unknown',
      namesProgram: typeof error?.detail === 'string' && error.detail.includes(ORDER_ENGINE),
      rows: null,
      instructions: null,
      byVerdict: null,
      disagreementKinds: null,
    };
  }
}

function cliCase(store, only) {
  const args = [BIN, 'conform', TX_PATH, '--store', store];
  if (only !== undefined) args.push('--only', only);
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  let instructions = null;
  let rows = null;
  let byVerdict = null;
  try {
    const report = JSON.parse(result.stdout);
    instructions = report?.summary?.instructions ?? null;
    rows = Array.isArray(report?.rows) ? report.rows.length : null;
    byVerdict = report?.summary?.byVerdict ?? null;
  } catch {
    // no report printed (refusal goes to stderr) — a fact, not a failure
  }
  const reasonMatch = /conformance refused: ([a-z-]+)/.exec(result.stderr ?? '');
  return {
    exit: result.status,
    instructions,
    rows,
    byVerdict,
    refusalReason: reasonMatch ? reasonMatch[1] : null,
  };
}

const damaged = tamperedStore();
const noReceipts = storeWithoutReceipts();
const missing = path.join(tmpRoot, 'does-not-exist');

const cases = {};
for (const [name, store, only] of [
  ['damagedReceipt', damaged, ORDER_ENGINE],
  ['missingStore', missing, undefined],
  ['noReceiptsDir', noReceipts, undefined],
  ['honestGap', STORE, TOKEN_PROGRAM],
  ['intactViolation', STORE, ORDER_ENGINE],
]) {
  cases[name] = { library: await libraryCase(store, only), cli: cliCase(store, only) };
}

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(JSON.stringify({ cases }, null, 2));
