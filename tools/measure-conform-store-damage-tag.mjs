#!/usr/bin/env node
// measure-conform-store-damage-tag — does the PUBLISHED install refuse a
// store it cannot read?
//
// WHY THIS IS NOT THE SAME AS THE WORKING-TREE MEASUREMENT
// (tools/measure-conform-store-damage.mjs):
//   The working-tree measurement asks whether THIS code refuses. It cannot
//   say what a stranger receives. This repo has measured that gap repeatedly
//   — "main fixed, the pin pointing behind it" — so this tool installs the
//   PUBLISHED TAGS into an empty directory and runs the same cases against
//   the bytes a stranger gets.
//
// WHAT IT MEASURES (per tag):
//   damagedReceipt  a receipt whose fingerprint no longer matches its object
//                     -> the defect: exit 0, rows all `no-stored-interface`
//   missingStore    a --store directory that does not exist
//                     -> the same green
//   noReceiptsDir   a --store directory with objects/ but no receipts/
//                     -> the same green
//   honestGap       the INTACT store, --only <program it does not hold>
//                     -> control: must still report the gap, exit 0
//   intactViolation the INTACT store, --only <program it holds and which
//                   genuinely disagrees>
//                     -> control: must still find it and exit 1
//
//   A tag is VERDICTED, not compared blindly:
//     * a tag that exits 0 over any unreadable store carries the defect
//     * a tag whose controls fail carries a BROKEN conform path (worse)
//     * a tag that refuses all three with a named reason and keeps both
//       controls working is CLEAN
//
// NO VERDICT (exit 3) if a tag cannot be installed or a fixture is missing:
// an unmeasured tag is never called clean.
//
// Usage: node tools/measure-conform-store-damage-tag.mjs [--tags v0.4.14,v0.4.15]
//                                                      [--out <file>]
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
const TAGS = flag('--tags', 'v0.4.14,v0.4.15').split(',').map((t) => t.trim()).filter(Boolean);
const OUT = flag('--out', path.join(ROOT, 'research', 'conform-store-damage-tag-2026-11-10.json'));

const TX = path.join(ROOT, 'test', 'fixtures', 'order-engine-conformance-tx.json');
const STORE_SRC = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled');
const ORDER_ENGINE = '2En5Y11SEAGLNmEezTuRUCwTyzyNReHaMbSnS5gjGsL1';
const TOKEN_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

if (!fs.existsSync(TX) || !fs.existsSync(STORE_SRC)) {
  console.error(JSON.stringify({ verdict: 'NO VERDICT', reason: 'the tx fixture or the store fixture is missing' }));
  process.exit(3);
}

function runCase(cwd, store, args) {
  const result = spawnSync(process.execPath,
    [path.join(cwd, 'node_modules', 'sememe', 'bin', 'sememe.mjs'), 'conform', TX, '--store', store, ...args],
    { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = String(result.stdout || '');
  let parsed = null;
  try { parsed = JSON.parse(out); } catch { /* refusal text, not JSON */ }
  const reason = (String(result.stderr || '') + out).match(/conformance refused: ([a-z0-9-]+)/)?.[1] ?? null;
  const byVerdict = parsed?.summary?.byVerdict ?? null;
  return {
    exit: result.status,
    instructions: parsed?.summary?.instructions ?? null,
    rows: Array.isArray(parsed?.rows) ? parsed.rows.length : null,
    byVerdict,
    disagreementKinds: byVerdict ? Object.keys(byVerdict).filter((kind) =>
      !['conforms', 'no-stored-interface', 'unknown-instruction', 'unknown-discriminator',
        'remaining-accounts', 'short-optional-tail'].includes(kind)) : null,
    refusalReason: reason,
  };
}

function measureTag(tag) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `sememe-csdtag-${tag.replace(/[^\w.]/g, '_')}-`));
  try {
    // Three stores the installed CLI is pointed at:
    const damaged = path.join(work, 'store-damaged');
    fs.cpSync(STORE_SRC, damaged, { recursive: true });
    const receiptsDir = path.join(damaged, 'receipts');
    const target = fs.readdirSync(receiptsDir).find((n) => n.startsWith(`${ORDER_ENGINE}-`));
    if (!target) return { tag, error: 'the store fixture holds no order-engine receipt' };
    const receiptPath = path.join(receiptsDir, target);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.fingerprint = `sha256:${'0'.repeat(64)}`;
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));

    const intact = path.join(work, 'store-intact');
    fs.cpSync(STORE_SRC, intact, { recursive: true });

    const noReceipts = path.join(work, 'store-noreceipts');
    fs.mkdirSync(path.join(noReceipts, 'objects'), { recursive: true });

    const missing = path.join(work, 'store-does-not-exist');

    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'tag-journey', private: true, version: '0.0.0' }));
    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', `github:auroraxo/sememe#${tag}`],
      { cwd: work, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (install.status !== 0) {
      return { tag, error: `install failed: ${String(install.stderr || install.stdout).slice(0, 300)}` };
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(work, 'node_modules', 'sememe', 'package.json'), 'utf8'));

    const cases = {
      damagedReceipt: runCase(work, damaged, ['--only', ORDER_ENGINE]),
      missingStore: runCase(work, missing, []),
      noReceiptsDir: runCase(work, noReceipts, []),
      honestGap: runCase(work, intact, ['--only', TOKEN_PROGRAM]),
      intactViolation: runCase(work, intact, ['--only', ORDER_ENGINE]),
    };

    const UNREADABLE = ['damagedReceipt', 'missingStore', 'noReceiptsDir'];
    const greenOverUnreadableStore = UNREADABLE.filter((n) => cases[n].exit === 0);
    const controlsBroken = ['honestGap', 'intactViolation'].filter((n) => {
      const wantExit = n === 'honestGap' ? 0 : 1;
      return cases[n].exit !== wantExit;
    });

    const verdict = greenOverUnreadableStore.length > 0
      ? 'carries-the-defect'
      : (controlsBroken.length > 0 ? 'broken-controls' : 'refuses');

    return { tag, installedVersion: pkg.version, cases, greenOverUnreadableStore, controlsBroken, verdict };
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
  tool: 'tools/measure-conform-store-damage-tag.mjs',
  measuredAt: new Date().toISOString(),
  tags: results,
  // The fix is only in the delivery if the newest tag refuses and an older
  // one is shown to have carried the defect.
  ok: results.some((r) => r.verdict === 'carries-the-defect')
    && results.some((r) => r.verdict === 'refuses'),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify(artifact, null, 2));
process.exit(artifact.ok ? 0 : 1);
