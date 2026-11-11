#!/usr/bin/env node
// tools/measure-conform-unresolvable-accounts-tag.mjs — does the PUBLISHED
// install refuse a transaction whose ACCOUNT indices do not resolve?
//
// WHY THIS EXISTS (the repo's most-repeated defect):
//   "main fixed, the pin pointing behind it". The working-tree measurement
//   proves the tree in front of us is clean; it cannot prove what a stranger
//   gets from running `npm install github:auroraxo/sememe#<pinned-tag>`.
//   This tool installs the PUBLISHED TAGS into an empty directory and runs
//   the same defect cases against the bytes a consumer receives.
//
// WHAT IT MEASURES (per tag):
//   droppedExtraSigner  the fill's ONE signing-extra account index pushed
//                       past accountKeys
//                         -> defect: exit 0, verdict remaining-accounts,
//                            the real undeclared-signing-account finding HIDDEN
//   droppedFillAll      the whole fill accounts list unresolvable
//   droppedCpi          the first CPI instruction loses an account index
//   parsedObjectAccounts the whole transaction in jsonParsed object shape
//   intactControl       untouched fixture transaction
//                         -> control: must still report
//                            undeclared-signing-account and exit 1
//   emptyAccountsControl  an empty accounts list — legal, never refused
//                         -> over-refusal control: must stay unrefused
//
// VERDICT RULES:
//   * a tag that exits 0 over any dropped shape carries the defect
//   * a tag whose controls fail carries broken conform logic
//   * a tag that refuses all dropped shapes with the named reason and keeps
//     both controls working is CLEAN
//
// Usage: node tools/measure-conform-unresolvable-accounts-tag.mjs [--tags v0.4.16,v0.4.17]
//                                                                 [--out <file>]
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
const TAGS = flag('--tags', 'v0.4.16,v0.4.17').split(',').map((t) => t.trim()).filter(Boolean);
const OUT = flag('--out', path.join(ROOT, 'research', 'conform-unresolvable-accounts-tag-2026-11-11.json'));

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
  const droppedExtraSigner = baseTx();
  droppedExtraSigner.transaction.message.instructions[3].accounts[11] = keyCount(droppedExtraSigner) + 86;
  const droppedFillAll = baseTx();
  droppedFillAll.transaction.message.instructions[3].accounts
    = droppedFillAll.transaction.message.instructions[3].accounts.map(() => keyCount(droppedFillAll) + 86);
  const droppedCpi = baseTx();
  const group = droppedCpi.meta.innerInstructions[0];
  group.instructions[1].accounts = [group.instructions[1].accounts[0], keyCount(droppedCpi) + 3];
  const parsedObjectAccounts = baseTx();
  {
    const keys = parsedObjectAccounts.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k?.pubkey));
    const n = parsedObjectAccounts.transaction.message.header.numRequiredSignatures;
    for (const instruction of parsedObjectAccounts.transaction.message.instructions) {
      instruction.accounts = instruction.accounts.map((i) => ({
        pubkey: keys[i], signer: i < n, writable: true,
      }));
    }
  }
  const intact = baseTx();
  const emptyAccounts = baseTx();
  for (const instruction of emptyAccounts.transaction.message.instructions) instruction.accounts = [];
  emptyAccounts.meta.innerInstructions = [];

  const write = (name, tx) => {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({ result: tx }));
    return file;
  };
  return {
    droppedExtraSigner: write('droppedExtraSigner', droppedExtraSigner),
    droppedFillAll: write('droppedFillAll', droppedFillAll),
    droppedCpi: write('droppedCpi', droppedCpi),
    parsedObjectAccounts: write('parsedObjectAccounts', parsedObjectAccounts),
    intactControl: write('intactControl', intact),
    emptyAccountsControl: write('emptyAccountsControl', emptyAccounts),
  };
}

function runCase(cwd, txFile) {
  const result = spawnSync(
    process.execPath,
    [path.join(cwd, 'node_modules', 'sememe', 'bin', 'sememe.mjs'), 'conform', txFile, '--store', STORE_SRC],
    { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const out = String(result.stdout || '');
  let parsed = null;
  try { parsed = JSON.parse(out); } catch { /* refusal text */ }
  const reason = (String(result.stderr || '') + out).match(/conformance refused: ([a-z0-9-]+)/)?.[1] ?? null;
  const fill = Array.isArray(parsed?.rows) ? parsed.rows.find((row) => row.instruction === 'fill') ?? null : null;
  return {
    exit: result.status,
    fillVerdict: fill ? fill.verdict : null,
    byVerdict: parsed?.summary?.byVerdict ?? null,
    refusalReason: reason,
  };
}

function measureTag(tag) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `sememe-acctag-${tag.replace(/[^\w.]/g, '_')}-`));
  try {
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'tag-journey', private: true, version: '0.0.0' }));
    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', `github:auroraxo/sememe#${tag}`],
      { cwd: work, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (install.status !== 0) {
      return { tag, error: `install failed: ${String(install.stderr || install.stdout).slice(0, 300)}` };
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(work, 'node_modules', 'sememe', 'package.json'), 'utf8'));
    const files = makeTxFiles(work);

    const cases = Object.fromEntries(
      Object.entries(files).map(([name, file]) => [name, runCase(work, file)]),
    );

    const DEFECT_CASES = ['droppedExtraSigner', 'droppedFillAll', 'droppedCpi', 'parsedObjectAccounts'];
    const expectedReason = 'instruction-account-index-unresolvable';
    const greenOverDropped = DEFECT_CASES.filter((n) => cases[n].exit === 0);
    const refusals = DEFECT_CASES.filter((n) => cases[n].exit === 1 && cases[n].refusalReason === expectedReason);
    const controlsBroken = [];
    if (cases.intactControl.exit !== 1 || cases.intactControl.fillVerdict !== 'undeclared-signing-account') {
      controlsBroken.push('intactControl');
    }
    if (cases.emptyAccountsControl.refusalReason === expectedReason) controlsBroken.push('emptyAccountsControl');

    const verdict = greenOverDropped.length > 0
      ? 'carries-the-defect'
      : (controlsBroken.length > 0 ? 'broken-controls' : 'refuses');

    return {
      tag,
      installedVersion: pkg.version,
      cases,
      greenOverDropped,
      refusedWithNamedReason: refusals,
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
  tool: 'tools/measure-conform-unresolvable-accounts-tag.mjs',
  measuredAt: new Date().toISOString(),
  tags: results,
  ok: results.some((r) => r.verdict === 'carries-the-defect')
    && results.some((r) => r.verdict === 'refuses'),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify(artifact, null, 2));
process.exit(artifact.ok ? 0 : 1);
