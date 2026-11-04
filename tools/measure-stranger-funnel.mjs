#!/usr/bin/env node
// measure-stranger-funnel.mjs — measure the ADOPTION FUNNEL, not the decoder.
//
// The card's gate is "an outside person runs sememe on their own data". Every
// measurement so far proved the decoder works inside this repository. The
// funnel is what stands between a curious stranger and that first run:
//
//   F1  a FRESH CLONE from GitHub runs the README quickstart verbatim and
//       passes — the copy-paste a stranger copies, on a tree nobody has
//       touched, at the commit GitHub actually serves;
//   F2  the PUBLISHED TAG installs into an EMPTY app (`npm install
//       github:auroraxo/sememe#vX.Y.Z`) with no npm account, and the
//       installed package's own entry decodes real mainnet payloads
//       byte-exactly from a store a consumer can build;
//   F3  the installed tree is the product, not the harness: the harness
//       (tools/, test/, research/) does NOT travel into node_modules.
//
// Everything here runs against GitHub and the registry — it is a network
// measurement BY DESIGN, and it is separate from the offline decode suite
// for that reason. Exit codes: 0 measured, 2 usage/IO, 3 no-verdict.
//
// Usage: node tools/measure-stranger-funnel.mjs [--tag v0.3.0] [--out <file>]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = 'https://github.com/auroraxo/sememe';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const tag = argOf('--tag', 'v0.3.0');
const outPath = argOf('--out', path.join(ROOT, 'research', `stranger-funnel-${new Date().toISOString().slice(0, 10)}.json`));

const work = path.join(os.tmpdir(), `sememe-funnel-${process.pid}`);
const report = { tool: 'measure-stranger-funnel', generatedAt: new Date().toISOString(), tag, steps: [] };

function step(name, fn) {
  const started = Date.now();
  try {
    const detail = fn();
    report.steps.push({ step: name, verdict: 'measured', ms: Date.now() - started, ...detail });
    return detail;
  } catch (error) {
    report.steps.push({ step: name, verdict: 'failed', ms: Date.now() - started, error: String(error?.message ?? error).split('\n')[0].slice(0, 300) });
    throw error;
  }
}

/** The README quickstart commands, read from the README — not hardcoded. */
function readmeQuickstartCommands() {
  const md = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const start = md.indexOf('## Quickstart');
  if (start < 0) throw Error('README has no ## Quickstart section');
  const next = md.indexOf('\n## ', start + 5);
  const section = md.slice(start, next === -1 ? md.length : next);
  return [...section.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((m) => m[1].replace(/\\\s*\n\s*/g, ' ').trim())
    .filter((block) => block.includes('stranger-decode.mjs'));
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

try {
  // ---- F1: a fresh clone from GitHub runs the README quickstart verbatim.
  const clone = step('fresh-clone', () => {
    execFileSync('git', ['clone', '--quiet', REPO], { cwd: work, stdio: 'pipe', timeout: 300_000 });
    const cloneDir = path.join(work, 'sememe');
    if (!existsSync(cloneDir)) throw Error('clone produced no directory');
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneDir, encoding: 'utf8' }).trim();
    return { cloneDir, commit };
  });

  const quickstart = step('readme-quickstart-commands', () => {
    const commands = readmeQuickstartCommands();
    if (!commands.length) throw Error('README quickstart carries no stranger-decode command');
    return { commands };
  });

  step('quickstart-on-fresh-clone', () => {
    const runs = [];
    let cloneDir = path.join(work, 'sememe-run');
    for (const command of quickstart.commands) {
      // The block may start with `git clone … && cd sememe &&` or assume the
      // clone already happened; either way the tool runs from a FRESH clone.
      const segments = command.split(/&&|\n/).map((s) => s.trim()).filter(Boolean);
      const toolIndex = segments.findIndex((s) => s.startsWith('node tools/stranger-decode.mjs'));
      if (toolIndex < 0) throw Error(`quickstart block has no tool segment: ${command}`);
      const prefix = segments.slice(0, toolIndex);
      if (prefix.length && !prefix.every((s) => /^git clone \S+/.test(s) || /^cd /.test(s))) {
        throw Error(`unexpected quickstart segment: ${prefix.find((s) => !/^git clone \S+|^cd /.test(s))}`);
      }
      const gitClone = prefix.find((s) => s.startsWith('git clone'));
      if (gitClone) {
        const url = gitClone.split(/\s+/)[2];
        if (url !== REPO) throw Error(`quickstart clones an unexpected URL: ${url}`);
        rmSync(cloneDir, { recursive: true, force: true });
        execFileSync('git', ['clone', '--quiet', url, 'sememe-run'], { cwd: work, stdio: 'pipe', timeout: 300_000 });
      } else if (!existsSync(cloneDir)) {
        // Second command in the README assumes the first block's clone: do
        // the same here so this block is measured on a fresh tree too.
        execFileSync('git', ['clone', '--quiet', REPO, 'sememe-run'], { cwd: work, stdio: 'pipe', timeout: 300_000 });
      }
      const tokens = segments[toolIndex].split(/\s+/).filter(Boolean);
      const stdout = execFileSync('node', tokens.slice(1), { cwd: cloneDir, encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
      const summary = JSON.parse(stdout);
      if (summary.status !== 'pass') throw Error(`quickstart command did not pass: ${command}`);
      runs.push({ command, summary });
    }
    return { runs };
  });

  // ---- F2/F3: the published tag installs into an EMPTY app and decodes.
  const install = step('install-published-tag', () => {
    const appDir = path.join(work, 'app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'stranger-app', version: '1.0.0', private: true, type: 'module' }, null, 2));
    execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', `${REPO}#${tag}`], { cwd: appDir, stdio: 'pipe', timeout: 600_000 });
    const installed = path.join(appDir, 'node_modules', 'sememe');
    if (!existsSync(installed)) throw Error('npm install produced no node_modules/sememe');
    const entries = readdirSync(installed).sort();
    return { appDir, installed, entries };
  });

  step('installed-tree-is-the-product', () => {
    const entries = install.entries;
    const forbidden = entries.filter((e) => ['tools', 'test', 'research', 'node_modules'].includes(e));
    if (forbidden.length) throw Error(`harness leaked into the installed tree: ${forbidden.join(', ')}`);
    for (const required of ['index.mjs', 'src', 'interface', 'vendor', 'bin']) {
      if (!entries.includes(required)) throw Error(`installed tree misses ${required}`);
    }
    return { entries, harnessAbsent: true };
  });

  const decode = step('decode-through-installed-entry', () => {
    // The consumer's own store, built from the published package's own
    // `sememe pull` write path would need the network; the funnel check uses
    // the committed store the README documents, copied in by the consumer.
    const storeDir = path.join(install.appDir, 'store');
    cpSync(path.join(ROOT, 'test/fixtures/traffic-sample-store-2026-11-04'), storeDir, { recursive: true });
    const harvest = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/harvest-whirlpool-2026-10-28.json'), 'utf8'));
    const app = path.join(install.appDir, 'consumer.mjs');
    writeFileSync(app, `import { decodeUnionPayload } from 'sememe';
import { readFileSync } from 'node:fs';
const store = process.argv[2];
const doc = JSON.parse(readFileSync(process.argv[3], 'utf8'));
let checked = 0, decoded = 0, errors = 0, noInterface = 0, byteExact = 0;
for (const tx of doc.transactions) {
  for (const p of tx.payloads ?? []) {
    checked += 1;
    try {
      const r = await decodeUnionPayload(store, doc.program, p.dataHex, { trailing: 'report' });
      decoded += 1;
      if (r.roundTripByteExact || r.describedRoundTripByteExact) byteExact += 1;
    } catch (error) {
      const message = String(error?.message ?? error);
      if (message.startsWith('no stored IDL')) noInterface += 1;
      else { errors += 1; if (errors <= 3) console.error('ERR', message.slice(0, 160)); }
    }
  }
}
console.log(JSON.stringify({ checked, decoded, errors, noInterface, byteExact }));
`);
    const stdout = execFileSync('node', ['consumer.mjs', storeDir, path.join(ROOT, 'test/fixtures/harvest-whirlpool-2026-10-28.json')], { cwd: install.appDir, encoding: 'utf8', timeout: 300_000 });
    const summary = JSON.parse(stdout);
    if (summary.checked === 0) throw Error('the consumer decoded nothing — the funnel proves nothing');
    if (summary.errors > 0) throw Error(`the installed package refused ${summary.errors} payloads`);
    if (summary.decoded !== summary.checked) throw Error('not every payload decoded through the installed entry');
    if (summary.byteExact !== summary.checked) throw Error('not every decoded payload round-tripped byte-exactly');
    return { summary };
  });

  report.verdict = 'funnel-measured';
} catch (error) {
  report.verdict = 'no-verdict';
  report.error = String(error?.message ?? error).split('\n')[0].slice(0, 300);
} finally {
  rmSync(work, { recursive: true, force: true });
}

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ verdict: report.verdict, out: outPath, steps: report.steps.map((s) => ({ step: s.step, verdict: s.verdict })) }));
process.exit(report.verdict === 'funnel-measured' ? 0 : 3);
