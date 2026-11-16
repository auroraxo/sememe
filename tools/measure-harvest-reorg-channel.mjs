// Two-tree measurement: does the mailbox reader ask the channel that carries
// retractions?
//
// The claim under test is the OTHER half of reeflog issue #1's reader
// contract. The seal on a row is a snapshot taken when that row is read; a
// retraction recorded AFTER that read never appears in it. reeflog delivers
// such retractions on a separate channel with its own cursor
// (`reorg tail`, `run_reorg_tail` in its src/main.rs): "a consumer that
// already read an event cannot learn about its retraction from the event
// stream".
//
// The measurement runs the REAL reeflog binary (not a stub): it initialises
// a journal and plants three enriched rows —
//
//   VALID_SIG       seal `finalized`, no reorg record   (live)
//   SEAL_SIG        seal `reverted`,  reorg record      (the seal knew)
//   LATE_SIG        seal `finalized`, reorg record      (the channel knew)
//
// The third row is the whole point: its seal still says `finalized`, so a
// reader that only looks at the row it is reading cannot see the retraction.
//
// Two faces, measured by re-running the same probe across the fix:
//   prefix — the harvest tool WITHOUT the channel read (seal gate only)
//   fixed  — the same tool WITH the channel read
//
// verdict `reader-honours-the-retraction-channel` = the prefix face shows
// LATE_SIG leaking into the payload sources and the fixed face shows it gone,
// with the retraction named.
//
// Usage: node tools/measure-harvest-reorg-channel.mjs [--reeflog-bin <path>] [--out <file>]

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};

const PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const OUT = path.resolve(option('--out', path.join(ROOT, 'research', 'harvest-reorg-channel-2026-11-16.json')));
const REEFLOG_BIN = path.resolve(option('--reeflog-bin',
  process.env.REEFLOG_BIN || path.join(ROOT, '..', 'reeflog', 'target', 'release', 'reeflog')));
const TOOL = path.join(ROOT, 'tools', 'harvest-reeflog.mjs');

if (!fs.existsSync(REEFLOG_BIN)) {
  console.error(`NO VERDICT: reeflog binary not found at ${REEFLOG_BIN} (pass --reeflog-bin or set REEFLOG_BIN)`);
  process.exit(3);
}

// --- no host path may reach the artifact -----------------------------------
const leakGuard = (s) => {
  const home = os.homedir();
  if (s.includes(home)) throw new Error(`host path leaked into the artifact: ${home}`);
};

const VALID_SIG = 'ValidSig1111111111111111111111111111111111111111';
const SEAL_SIG = 'SealSig111111111111111111111111111111111111111';
const LATE_SIG = 'LateSig1111111111111111111111111111111111111111';
const ENVELOPE = JSON.stringify({
  instructions: [{ inner: false, outer: 0, program_id: PROGRAM, accounts: [], data: '3Bvo8NsR' }],
  accounts_flags_source: 'message',
  token_changes: [],
});

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/// Build a fresh journal: one live row, one seal-retracted row, and one row
/// whose seal STILL says `finalized` while the retraction channel carries its
/// record — the state a reader reaches when the chain unmade the event after
/// the row was read.
function plantJournal(dir) {
  const db = path.join(dir, 'reeflog.db');
  const init = run(REEFLOG_BIN, ['init', '--db', db, '--program', PROGRAM]);
  if (init.code !== 0) throw new Error(`reeflog init failed: ${init.err.trim()}`);

  const sql = new DatabaseSync(db);
  const insert = sql.prepare(`INSERT INTO events
      (signature, slot, err, logs, source, first_seen, seal_status, seal_seen, payload_state, accounts, account_state)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const now = Date.now();
  insert.run(VALID_SIG, 100000, null, '["Program log: valid"]', 'ws', now, 'finalized', now, null, ENVELOPE, null);
  insert.run(SEAL_SIG, 100001, null, '["Program log: seal"]', 'ws', now, 'reverted', now, null, ENVELOPE, null);
  // LATE_SIG keeps `finalized`: only the reorg channel knows about this one.
  insert.run(LATE_SIG, 100002, null, '["Program log: late"]', 'ws', now, 'finalized', now, null, ENVELOPE, null);
  const reorg = sql.prepare(`INSERT INTO reorgs(signature, slot, detected_at, status_source, tx_source, detail)
    VALUES (?,?,?,?,?,?)`);
  reorg.run(SEAL_SIG, 100001, now, 'status', 'tx', 'both sources refused');
  reorg.run(LATE_SIG, 100002, now, 'status', 'tx', 'both sources refused');
  sql.close();

  // The mailbox must actually carry both signals — asserted, not assumed.
  const tail = run(REEFLOG_BIN, ['tail', '--db', db, '--cursor', path.join(dir, 'c.txt'), '--limit', '100']);
  const seals = {};
  for (const line of tail.out.split('\n').filter(Boolean)) {
    try {
      const row = JSON.parse(line);
      seals[row.signature] = row.seal;
    } catch { /* not a row */ }
  }
  if (seals[VALID_SIG] !== 'finalized' || seals[SEAL_SIG] !== 'reverted' || seals[LATE_SIG] !== 'finalized') {
    throw new Error(`reeflog did not mark the rows as expected: ${JSON.stringify(seals)}`);
  }
  const reorgTail = run(REEFLOG_BIN, ['reorg', 'tail', '--db', db, '--cursor', path.join(dir, 'rc.txt'), '--limit', '100']);
  const carried = reorgTail.out.split('\n').filter(Boolean).map((l) => JSON.parse(l).signature);
  if (!carried.includes(SEAL_SIG) || !carried.includes(LATE_SIG)) {
    throw new Error(`the retraction channel did not deliver both records: ${reorgTail.out}`);
  }
  return db;
}

/// Run the harvest tool once against a fresh journal and record what it said.
function measureOnce(tag, toolPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-harvest-reorg-'));
  try {
    const db = plantJournal(dir);
    const out = path.join(dir, 'harvest.json');
    let code = 0, stderr = '';
    try {
      execFileSync(process.execPath, [toolPath, '--db', db, '--out', out, '--reeflog-bin', REEFLOG_BIN],
        { encoding: 'utf8' });
    } catch (e) {
      code = e.status ?? 1;
      stderr = String(e.stderr ?? '');
    }
    const written = fs.existsSync(out);
    const doc = written ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
    return {
      tag,
      exitCode: code,
      documentWritten: written,
      stderr: stderr.trim().split('\n').slice(-1)[0] ?? '',
      pinnedSignatures: doc ? doc.counts.pinnedSignatures : null,
      latePinned: doc
        ? doc.signatures.some((s) => s.signature === LATE_SIG)
        : null,
      lateTransaction: doc
        ? doc.transactions.some((t) => t.signature === LATE_SIG)
        : null,
      sealPinned: doc
        ? doc.signatures.some((s) => s.signature === SEAL_SIG)
        : null,
      livePinned: doc
        ? doc.signatures.some((s) => s.signature === VALID_SIG)
        : null,
      rowsReverted: doc && 'rowsReverted' in doc.counts ? doc.counts.rowsReverted : null,
      lateNamed: doc && Array.isArray(doc.counts.reorgOnlySignatures)
        ? doc.counts.reorgOnlySignatures.includes(LATE_SIG)
        : null,
      reorgRetractions: doc && 'reorgRetractions' in doc.counts ? doc.counts.reorgRetractions : null,
      rowsWithoutEnvelope: doc ? doc.counts.rowsWithoutEnvelope : null,
      method: doc ? doc.method : null,
      _raw: doc ? { counts: doc.counts, signatures: doc.signatures } : null,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- pre-fix tree: the same tool without the channel read -------------------
const TOOL_ORIG = fs.readFileSync(TOOL, 'utf8');
const STASH = `${TOOL}.measure-bak`;

function prefixTool() {
  // The pre-fix state of THIS seam: the seal gate exists, the channel is
  // never read. Re-derivable from the source without git.
  const mutated = TOOL_ORIG.replace(
    "const reorgRun = await runReeflog(['reorg', 'tail', '--db', dbPath, '--cursor', reorgCursorPath, '--limit', String(tailLimit)]);",
    "const reorgRun = { code: 0, out: '', err: '' }; // mutated: the channel is not read",
  );
  if (mutated === TOOL_ORIG) throw new Error('could not derive the pre-fix tool (channel read not found)');
  fs.writeFileSync(STASH, TOOL_ORIG);
  fs.writeFileSync(TOOL, mutated);
}
function restoreTool() {
  if (fs.existsSync(STASH)) {
    fs.writeFileSync(TOOL, fs.readFileSync(STASH, 'utf8'));
    fs.unlinkSync(STASH);
  }
}

let prefix, fixed;
try {
  prefixTool();
  prefix = measureOnce('prefix', TOOL);
} finally {
  restoreTool();
}
fixed = measureOnce('fixed', TOOL);

// --- verdict ---------------------------------------------------------------
const faces = [
  {
    face: 'P1_the_channel_only_retraction_is_not_pinned',
    claim: "a signature only the retraction channel knows about must not be pinned (prefix/fixed = leak present)",
    prefix: prefix.latePinned === true,
    fixed: fixed.latePinned === true,
    detail: `prefix latePinned=${prefix.latePinned}, fixed=${fixed.latePinned}`,
  },
  {
    face: 'P2_the_channel_only_retraction_is_never_a_transaction',
    claim: 'no payload may be derived from a row whose seal looked live but the channel retracted',
    prefix: prefix.lateTransaction === true,
    fixed: fixed.lateTransaction === true,
    detail: `prefix lateTransaction=${prefix.lateTransaction}, fixed=${fixed.lateTransaction}`,
  },
  {
    face: 'P3_the_channel_only_retraction_is_named',
    claim: "failure = the document does not name the channel-only retraction",
    // Two of the three rows are retracted (the seal one and the channel-only
    // one); the live row is not, and never may be counted as retracted.
    prefix: !(prefix.rowsReverted === 2 && prefix.lateNamed === true),
    fixed: !(fixed.rowsReverted === 2 && fixed.lateNamed === true),
    detail: `prefix rowsReverted=${prefix.rowsReverted} lateNamed=${prefix.lateNamed}; fixed rowsReverted=${fixed.rowsReverted} lateNamed=${fixed.lateNamed}`,
  },
  {
    face: 'P4_the_live_row_survives_on_both_trees',
    claim: "failure = the fix dropped a live event too — the finalized row with no reorg record stays a payload source",
    prefix: prefix.livePinned !== true,
    fixed: fixed.livePinned !== true,
    detail: `prefix livePinned=${prefix.livePinned}, fixed=${fixed.livePinned}`,
  },
  {
    face: 'P5_the_seal_gate_still_works_on_both_trees',
    claim: 'failure = the seal-retracted row leaks (the seal gate must not be weakened by the channel work)',
    prefix: prefix.sealPinned === true,
    fixed: fixed.sealPinned === true,
    detail: `prefix sealPinned=${prefix.sealPinned}, fixed=${fixed.sealPinned}`,
  },
  {
    face: 'P6_a_retraction_is_not_an_open_envelope_debt',
    claim: 'failure = a row the chain forgot is counted as debt hydrate could ever close',
    prefix: prefix.rowsWithoutEnvelope !== 0,
    fixed: fixed.rowsWithoutEnvelope !== 0,
    detail: `prefix rowsWithoutEnvelope=${prefix.rowsWithoutEnvelope}, fixed rowsWithoutEnvelope=${fixed.rowsWithoutEnvelope}`,
  },
];

const defectPresent = faces.slice(0, 3).every((f) => f.prefix === true);
const defectGone = faces.slice(0, 3).every((f) => f.fixed === false);
const guardsHold = faces.slice(3).every((f) => f.prefix === false && f.fixed === false);

const verdict = (defectPresent && defectGone && guardsHold)
  ? 'reader-honours-the-retraction-channel'
  : (defectPresent && !defectGone)
    ? 'reader-still-ignores-the-retraction-channel'
    : 'no-verdict';

const artifact = {
  verdict,
  measuredAt: new Date().toISOString(),
  tool: 'tools/harvest-reeflog.mjs',
  method: 'real reeflog binary plants 3 enriched rows (live, seal-reverted, channel-only-retracted with seal still finalized); the repository harvest tool reads both channels with its zero-RPC guard; prefix = the same tool with the reorg-channel read removed',
  reeflogBinary: path.basename(REEFLOG_BIN),
  zeroRpcGuard: 'the tool imports tools/lib/network-guard.mjs first and exits 1 on any attempt (pinned by test/harvest-reeflog.test.mjs)',
  faces,
  prefix,
  fixed,
  limits: [
    'the probe is synthetic: a planted journal, not a fork observed on mainnet',
    'this artifact measures the CHANNEL half of the reader contract; the row SEAL half is measured in research/harvest-retraction-2026-11-16.json',
    'one channel-only retraction; retractions for rows outside this read are covered by G1 in test/harvest-reeflog-reorg-channel.test.mjs',
  ],
};

leakGuard(JSON.stringify(artifact));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(JSON.stringify({ out: OUT, verdict, faces: faces.map((f) => ({ face: f.face, prefix: f.prefix, fixed: f.fixed })) }, null, 2));
