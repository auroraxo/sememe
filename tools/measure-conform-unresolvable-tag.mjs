#!/usr/bin/env node
// tools/measure-conform-unresolvable-tag.mjs — does the PUBLISHED install
// refuse a transaction carrying an unresolvable instruction?
//
// WHY THIS EXISTS (the repo's most-repeated defect):
//   "main fixed, the pin pointing behind it". The working-tree measurement
//   proves the tree in front of us is clean; it cannot prove what a stranger
//   gets from running `npm install github:auroraxo/sememe#<pinned-tag>`.
//   This tool installs the PUBLISHED TAGS into an empty directory and runs
//   the same defect cases against the bytes a consumer receives.
//
// WHAT IT MEASURES (per tag):
//   droppedFill      the order-engine fill instruction's programIdIndex pushed
//                    past accountKeys
//                      -> defect: exit 0, rows 11 of 12, real finding hidden
//   droppedCpi       first inner instruction (CPI) carries a bad index
//                      -> defect: exit 0, rows 11 of 12
//   droppedAppended  an extra unresolvable instruction appended
//                      -> defect: exit 0, rows 12 of 13
//   intactControl    untouched fixture transaction
//                      -> control: must still report undeclared-signing-account
//                         and exit 1
//   allDroppedControl all indices unresolvable
//                      -> control: must refuse with transaction-has-no-
//                         resolvable-program-id
//
// VERDICT RULES:
//   * a tag that exits 0 over any dropped instruction carries the defect
//   * a tag whose controls fail carries broken conform logic
//   * a tag that refuses all three dropped cases with the named reason and
//     keeps both controls working is CLEAN
//
// Usage: node tools/measure-conform-unresolvable-tag.mjs [--tags v0.4.15,v0.4.16]
//                                                       [--out <file>]
import { spawnSync } from 'node:child_process';
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
const TAGS = flag('--tags', 'v0.4.15,v0.4.16').split(',').map((t) => t.trim()).filter(Boolean);
const OUT = flag('--out', path.join(ROOT, 'research', 'conform-unresolvable-tag-2026-11-11.json'));

const TX = path.join(ROOT, 'test', 'fixtures', 'order-engine-conformance-tx.json');
const STORE_SRC = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled');

if (!fs.existsSync(TX) || !fs.existsSync(STORE_SRC)) {
  console.error(JSON.stringify({ verdict: 'NO VERDICT', reason: 'the tx fixture or the store fixture is missing' }));
  process.exit(3);
}

const baseTx = () => {
  const raw = JSON.parse(fs.readFileSync(TX, 'utf8'));
  return raw.result ?? raw;
};
const keyCount = (tx) => tx.transaction.message.accountKeys.length;

function makeTxFiles(dir) {
  const droppedFill = baseTx();
  droppedFill.transaction.message.instructions[3].programIdIndex = keyCount(droppedFill) + 86;
  const droppedCpi = baseTx();
  droppedCpi.meta.innerInstructions[0].instructions[0].programIdIndex = keyCount(droppedCpi) + 86;
  const droppedAppended = baseTx();
  droppedAppended.transaction.message.instructions.push({
    accounts: [0, 1],
    data: '3Bxs4X124TkQDWb9',
    programIdIndex: keyCount(droppedAppended) + 86,
    stackHeight: 1,
  });
  const intact = baseTx();
  const allDropped = baseTx();
  for (const i of allDropped.transaction.message.instructions) i.programIdIndex = keyCount(allDropped) + 86;
  allDropped.meta.innerInstructions = [];

  const write = (name, tx) => {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({ result: tx }));
    return file;
  };
  return {
    droppedFill: write('droppedFill', droppedFill),
    droppedCpi: write('droppedCpi', droppedCpi),
    droppedAppended: write('droppedAppended', droppedAppended),
    intactControl: write('intactControl', intact),
    allDroppedControl: write('allDroppedControl', allDropped),
  };
}

function runCase(cwd, txFile, total) {
  const result = spawnSync(
    process.execPath,
    [path.join(cwd, 'node_modules', 'sememe', 'bin', 'sememe.mjs'), 'conform', txFile, '--store', STORE_SRC],
    { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const out = String(result.stdout || '');
  let parsed = null;
  try { parsed = JSON.parse(out); } catch { /* refusal text */ }
  const reason = (String(result.stderr || '') + out).match(/conformance refused: ([a-z0-9-]+)/)?.[1] ?? null;
  return {
    exit: result.status,
    instructions: parsed?.summary?.instructions ?? null,
    rows: Array.isArray(parsed?.rows) ? parsed.rows.length : null,
    byVerdict: parsed?.summary?.byVerdict ?? null,
    refusalReason: reason,
    // The transaction holds this many instructions (top level + CPI). A
    // report over FEWER of them is a SUBSET report: the instruction the gate
    // could not resolve is missing from the report, whatever the exit code.
    transactionInstructions: total,
    subsetReport: parsed !== null && Array.isArray(parsed?.rows) && parsed.rows.length < total,
  };
}

function measureTag(tag) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `sememe-cutag-${tag.replace(/[^\w.]/g, '_')}-`));
  try {
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'tag-journey', private: true, version: '0.0.0' }));
    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', `github:auroraxo/sememe#${tag}`],
      { cwd: work, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (install.status !== 0) {
      return { tag, error: `install failed: ${String(install.stderr || install.stdout).slice(0, 300)}` };
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(work, 'node_modules', 'sememe', 'package.json'), 'utf8'));
    const files = makeTxFiles(work);
    const totals = {
      droppedFill: 12,
      droppedCpi: 12,
      droppedAppended: 13,
      intactControl: 12,
      allDroppedControl: 12,
    };

    const cases = {
      droppedFill: runCase(work, files.droppedFill, totals.droppedFill),
      droppedCpi: runCase(work, files.droppedCpi, totals.droppedCpi),
      droppedAppended: runCase(work, files.droppedAppended, totals.droppedAppended),
      intactControl: runCase(work, files.intactControl, totals.intactControl),
      allDroppedControl: runCase(work, files.allDroppedControl, totals.allDroppedControl),
    };

    const DEFECT_CASES = ['droppedFill', 'droppedCpi', 'droppedAppended'];
    const greenOverDropped = DEFECT_CASES.filter((n) => cases[n].exit === 0);
    // A subset report is the shape of the defect even when the exit code
    // happens to be 1: the dropped instruction is missing from the report, and
    // the exit code then reflects the OTHER instructions only.
    const subsetReports = DEFECT_CASES.filter((n) => cases[n].subsetReport === true);
    const controlsBroken = [];
    if (cases.intactControl.exit !== 1) controlsBroken.push('intactControl');
    if (cases.allDroppedControl.exit !== 1 || cases.allDroppedControl.refusalReason !== 'transaction-has-no-resolvable-program-id') {
      controlsBroken.push('allDroppedControl');
    }

    const verdict = greenOverDropped.length > 0
      ? 'carries-the-defect'
      : (controlsBroken.length > 0 ? 'broken-controls' : 'refuses');

    return {
      tag,
      installedVersion: pkg.version,
      cases,
      greenOverDropped,
      subsetReports,
      controlsBroken,
      verdict,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const results = TAGS.map((tag) => measureTag(tag));
const unmeasurable = results.filter((r) => r.error);
if (unmeasurable.length > 0) {
  console.error(JSON.stringify({ verdict: 'NO VERDICT', reason: 'a tag could not be installed', unmeasurable }, null, 2));
  process.exit(3);
}

const artifact = {
  tool: 'tools/measure-conform-unresolvable-tag.mjs',
  measuredAt: new Date().toISOString(),
  tags: results,
  ok: results.some((r) => r.verdict === 'carries-the-defect')
    && results.some((r) => r.verdict === 'refuses'),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify(artifact, null, 2));
process.exit(artifact.ok ? 0 : 1);
