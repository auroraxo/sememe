// tools/measure-mailbox-shipped.mjs — measure the claim ON THE CHANNEL A
// STRANGER INSTALLS: can a consumer who ran `npm install sememe` read a
// reeflog mailbox?
//
// Why a two-CHANNEL measurement and not a two-COMMIT one
// ------------------------------------------------------
// The defect this tool was written for is a PUBLISHING defect, not a code
// defect: the reader existed in `tools/harvest-reeflog.mjs` the whole time,
// and `tools/` is excluded from the package's `files` allowlist. Measuring
// two commits of this repository would have said "fixed" while the published
// tarball still refused. So both sides are measured as INSTALLED PACKAGES:
//
//   carrier  sememe@<published>   installed from the npm registry into an
//                                empty app — the bytes a stranger gets today
//   fixed    npm pack of this    installed into a second empty app — the
//            tree                bytes the next release would ship
//
// Both run the SAME byte-identical probe: does the subpath resolve, does the
// reader exist, and does it answer the same real journal rows the same way.
//
// The probe runs against REAL journal rows (a local `reeflog` binary dumps
// `tail` + `reorg tail`), so the answer is about behaviour, not exports alone.
// Nothing here touches the network except the two npm installs.
//
// Usage:
//   node tools/measure-mailbox-shipped.mjs \
//     --db <reeflog.db> --reeflog-bin <path> [--store <dir>] \
//     [--program <id>] [--carrier sememe@0.4.33] [--out research/<file>.json]
//
// Exit 0 = the artifact was written; the VERDICT is inside it. The tool exits
// 1 when the measurement itself could not run (so a broken probe can never
// look like a held claim).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v === undefined) { console.error(`missing value for ${name}`); process.exit(2); }
  args.splice(i, 2);
  return v;
};

const dbPath = option('--db', null);
const reeflogBin = option('--reeflog-bin', null);
const storeDir = option('--store', null);
const program = option('--program', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const carrierSpec = option('--carrier', null);
const outPath = option('--out', null);

if (!dbPath || !reeflogBin) {
  console.error('usage: node tools/measure-mailbox-shipped.mjs --db <reeflog.db> --reeflog-bin <bin> [--store <dir>] [--carrier sememe@x.y.z] [--out <file>]');
  process.exit(2);
}
if (!fs.existsSync(dbPath)) { console.error(`journal not found: ${dbPath}`); process.exit(2); }
if (!fs.existsSync(reeflogBin)) { console.error(`reeflog binary not found: ${reeflogBin}`); process.exit(2); }

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-mailbox-measure-'));

// Host paths must never reach the artifact: the leak guard is part of the
// claim ("no absolute path in the record"), and a tmpdir path would put a
// username in a file that gets committed.
const scrub = (s) => String(s).replaceAll(work, '<work>');

const fail = (message) => {
  console.error(`MEASUREMENT FAILED: ${message}`);
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(1);
};

// maxBuffer: an envelope-bearing row carries the full account list, the
// instruction bytes and the balance changes — a few thousand rows blow past
// spawnSync's 1 MB default and the read dies with ENOBUFS (measured 2026-11-17
// on a real 2,417-event journal before this line existed).
const run = (cmd, cmdArgs, opts = {}) => spawnSync(cmd, cmdArgs, {
  encoding: 'utf8', timeout: 600_000, maxBuffer: 512 * 1024 * 1024, ...opts,
});

// --- 1. the journal's own rows, read once, byte-identical for both apps -----
const freshCursors = fs.mkdtempSync(path.join(work, 'cursors-'));
const tail = run(reeflogBin, ['tail', '--db', dbPath, '--cursor', path.join(freshCursors, 'e.txt'), '--limit', '5000']);
if (tail.error) fail(`reeflog tail could not run: ${tail.error.message}`);
const reorg = run(reeflogBin, ['reorg', 'tail', '--db', dbPath, '--cursor', path.join(freshCursors, 'r.txt'), '--limit', '5000']);
if (reorg.error) fail(`reeflog reorg tail could not run: ${reorg.error.message}`);
if (reorg.status !== 0) fail(`reorg tail exited ${reorg.status}: ${(reorg.stderr || '').slice(-300)}`);

const parseLines = (text) => String(text).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const rows = parseLines(tail.stdout);
const retractions = parseLines(reorg.stdout);
if (!rows.length) fail('the journal produced no rows — nothing to measure against');
fs.writeFileSync(path.join(work, 'rows.json'), JSON.stringify({ rows, retractions }));

// --- 2. install both packages into empty apps --------------------------------
const npmInstall = (dir, spec) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'probe', private: true, type: 'module' }, null, 2));
  const r = run('npm', ['install', spec, '--silent', '--no-audit', '--no-fund'], { cwd: dir });
  if (r.status !== 0) fail(`npm install ${spec} failed: ${String(r.stderr).slice(-400)}`);
};

// --- 3. the probe: same script, same inputs, both installed copies -----------
// It answers three questions and prints one JSON line:
//   subpath   does the reader surface resolve at all?
//   reader    does the reader exist and answer?
//   behaviour does it produce the SAME transactions and counts?
const PROBE = `
import fs from 'node:fs';
const out = { subpath: 'refused', subpathCode: null, reader: null, behaviour: null, error: null };
try {
  const mod = await import('sememe/mailbox');
  out.subpath = 'resolved';
  out.reader = typeof mod.mailboxTransactions === 'function' ? 'present' : 'missing';
  if (out.reader === 'present') {
    const { rows, retractions } = JSON.parse(fs.readFileSync(process.env.PROBE_ROWS, 'utf8'));
    const { transactions, counts } = mod.mailboxTransactions({
      rows, retractions, program: process.env.PROBE_PROGRAM, channelRead: true,
    });
    out.behaviour = {
      transactions: transactions.map((t) => ({ signature: t.signature, payloads: t.payloads.length })),
      counts: {
        journalRows: counts.journalRows,
        payloads: counts.payloads,
        rowsReverted: counts.rowsReverted,
        revertedSignatures: counts.revertedSignatures,
        reorgRetractions: counts.reorgRetractions,
        reorgOnlySignatures: counts.reorgOnlySignatures,
        channelRead: counts.channelRead,
        rowsWithoutEnvelope: counts.rowsWithoutEnvelope,
        rowsWithoutInstructions: counts.rowsWithoutInstructions,
      },
    };
    if (process.env.PROBE_STORE) {
      const { decodePayload } = await import('sememe');
      let decoded = 0, roundTrip = 0;
      const refusals = [];
      for (const tx of transactions) {
        for (const p of tx.payloads) {
          try {
            const r = await decodePayload(process.env.PROBE_STORE, process.env.PROBE_PROGRAM, p.dataHex);
            if (r?.name) { decoded++; if (r.roundTripByteExact || r.describedRoundTripByteExact) roundTrip++; }
          } catch (e) { refusals.push(String(e.code ?? e.message).slice(0, 120)); }
        }
      }
      out.behaviour.decode = { decoded, roundTrip, refusals: refusals.length, refusalSample: refusals.slice(0, 3) };
    }
  }
} catch (e) {
  out.subpath = 'refused';
  out.subpathCode = e.code ?? null;
  out.error = String(e.message).split('\\n')[0].slice(0, 200);
}
process.stdout.write(JSON.stringify(out));
`;
// (the probe is written into each app by probeIn below)

const probeEnv = {
  ...process.env,
  PROBE_ROWS: path.join(work, 'rows.json'),
  PROBE_PROGRAM: program,
};
if (storeDir) probeEnv.PROBE_STORE = storeDir;

// The version actually INSTALLED, read from the app's node_modules — never the
// version asked for. A measurement that compares a package against itself
// proves nothing, so the pin can assert carrierVersion != fixedVersion.
const installedVersion = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', 'sememe', 'package.json'), 'utf8')).version;
  } catch { return null; }
};

// The probe MUST live inside the app directory: Node resolves a bare
// specifier like "sememe/mailbox" against the nearest node_modules going UP
// from the IMPORTING FILE, not from process.cwd(). A probe outside the app
// resolves nothing and every channel would answer ERR_MODULE_NOT_FOUND —
// which is exactly what the first run of this tool measured (2026-11-17:
//// carrier AND fixed both "refused", which was the harness's bug, not a
// verdict). The probe is written into each app separately, byte-identical.
const probeIn = (dir) => {
  const probePath = path.join(dir, 'probe.mjs');
  fs.writeFileSync(probePath, PROBE);
  const r = run(process.execPath, [probePath], { cwd: dir, env: probeEnv });
  if (r.status !== 0) fail(`probe failed in ${path.basename(dir)}: ${String(r.stderr).slice(-400)}`);
  try { return JSON.parse(r.stdout); } catch { fail(`probe printed no JSON in ${path.basename(dir)}: ${r.stdout.slice(0, 300)}`); }
};

const carrierDir = path.join(work, 'carrier');
const fixedDir = path.join(work, 'fixed');

const results = { carrier: null, fixed: null };

if (carrierSpec) {
  npmInstall(carrierDir, carrierSpec);
  results.carrier = { spec: carrierSpec, installedVersion: installedVersion(carrierDir), ...probeIn(carrierDir) };
}

// pack THIS tree (prepack runs the shipped-README gate), install the tarball
const pack = run('npm', ['pack', '--pack-destination', work], { cwd: ROOT });
if (pack.status !== 0) fail(`npm pack failed: ${String(pack.stderr).slice(-400)}`);
const tarballName = String(pack.stdout).trim().split('\n').pop();
const tarball = path.join(work, tarballName);
if (!fs.existsSync(tarball)) fail(`npm pack produced no tarball (${tarballName})`);
const localVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
npmInstall(fixedDir, tarball);
results.fixed = { spec: `file:${tarballName}`, version: localVersion, installedVersion: installedVersion(fixedDir), ...probeIn(fixedDir) };

// --- 4. verdict --------------------------------------------------------------
const c = results.carrier;
const f = results.fixed;
const behaviourIdentical = Boolean(
  f.behaviour
  && (!c?.behaviour || JSON.stringify(c.behaviour) === JSON.stringify(f.behaviour)),
);

const verdict = !f.behaviour
  ? 'not-shipped-in-fixed'
  : !c?.behaviour
    ? 'closed-on-the-published-channel'
    : behaviourIdentical
      ? 'same-behaviour-both-channels'
      : 'behaviour-diverges';

const artifact = {
  measuredAt: new Date().toISOString(),
  verdict,
  program,
  journal: { rows: rows.length, retractions: retractions.length, sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex').slice(0, 16) },
  carrier: c ? { spec: c.spec, installedVersion: c.installedVersion, subpath: c.subpath, subpathCode: c.subpathCode, reader: c.reader, error: c.error, behaviour: c.behaviour } : { spec: null, note: 'not measured' },
  fixed: { spec: f.spec, version: f.version, installedVersion: f.installedVersion, subpath: f.subpath, subpathCode: f.subpathCode, reader: f.reader, error: f.error, behaviour: f.behaviour },
  behaviourIdentical,
  checks: [
    { name: 'fixed-package-subpath-resolves', ok: f.subpath === 'resolved' },
    { name: 'fixed-reader-present', ok: f.reader === 'present' },
    { name: 'fixed-reader-answers-real-rows', ok: Boolean(f.behaviour && f.behaviour.counts.journalRows > 0) },
    { name: 'retraction-counted-on-the-fixed-channel', ok: Boolean(f.behaviour && typeof f.behaviour.counts.rowsReverted === 'number' && f.behaviour.counts.channelRead === true) },
    ...(c ? [{ name: 'carrier-subpath-refused', ok: c.subpath === 'refused' }] : []),
    // A comparison against itself measures nothing — the two installed
    // versions must differ for the verdict to mean anything.
    { name: 'installed-versions-differ', ok: Boolean(c && c.installedVersion && f.installedVersion && c.installedVersion !== f.installedVersion) },
    ...(c?.behaviour ? [{ name: 'behaviour-identical-across-channels', ok: behaviourIdentical }] : []),
  ],
};
artifact.checksPass = `${artifact.checks.filter((x) => x.ok).length}/${artifact.checks.length}`;

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${scrub(JSON.stringify(artifact, null, 2))}\n`);
  console.log(`wrote ${outPath}`);
}
console.log(JSON.stringify({ verdict, checksPass: artifact.checksPass, carrier: artifact.carrier.subpath, fixed: artifact.fixed.subpath, journal: artifact.journal }, null, 2));

fs.rmSync(work, { recursive: true, force: true });
process.exit(0);
