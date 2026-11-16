// Two-tree measurement: does the mailbox reader honour a retraction?
//
// The claim under test is reeflog issue #1's, moved to the reader side:
// reeflog marks a chain-unmade event (`tail` prints `"seal":"reverted"` and
// `reorg tail` carries the retraction), and a reader that drops that signal
// feeds its downstream a payload for an event that does not exist.
//
// The measurement runs the REAL reeflog binary (not a stub): it initialises a
// journal, plants one finalized and one reverted row — both with a full
// account envelope, the shape a harvest actually consumes — and runs the
// repository's own `tools/harvest-reeflog.mjs` against it, zero RPC enforced
// by the tool's own guard.
//
// Two faces, measured by re-running the same probe across the fix:
//   prefix — the harvest tool WITHOUT the seal gate
//   fixed  — the same tool WITH it
//
// verdict `reader-honours-retraction` = the prefix face shows the defect and
// the fixed face shows it gone, with the retraction named in the document.
//
// Usage: node tools/measure-harvest-retraction.mjs [--reeflog-bin <path>] [--out <file>]

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
const OUT = path.resolve(option('--out', path.join(ROOT, 'research', 'harvest-retraction-2026-11-16.json')));
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
const REVERTED_SIG = 'RevertedSig11111111111111111111111111111111111111';
const ENVELOPE = JSON.stringify({
  instructions: [{ inner: false, outer: 0, program_id: PROGRAM, accounts: [], data: '3Bvo8NsR' }],
  accounts_flags_source: 'message',
  token_changes: [],
});

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/// Build a fresh journal with one live and one retracted row, both enriched.
function plantJournal(dir) {
  const db = path.join(dir, 'reeflog.db');
  const init = run(REEFLOG_BIN, ['init', '--db', db, '--program', PROGRAM]);
  if (init.code !== 0) throw new Error(`reeflog init failed: ${init.err.trim()}`);

  // node:sqlite — no external client, same as reeflog's own harnesses.
  const sql = new DatabaseSync(db);
  const insert = sql.prepare(`INSERT INTO events
      (signature, slot, err, logs, source, first_seen, seal_status, seal_seen, payload_state, accounts, account_state)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const now = Date.now();
  insert.run(VALID_SIG, 100000, null, '["Program log: valid"]', 'ws', now, 'finalized', now, null, ENVELOPE, null);
  insert.run(REVERTED_SIG, 100001, null, '["Program log: unmade"]', 'ws', now, 'reverted', now, null, ENVELOPE, null);
  const reorg = sql.prepare(`INSERT INTO reorgs(signature, slot, detected_at, status_source, tx_source, detail)
    VALUES (?,?,?,?,?,?)`);
  reorg.run(REVERTED_SIG, 100001, now, 'status', 'tx', 'both sources refused');
  sql.close();

  // The retraction must be on the mailbox side, not only in our assertion.
  const tail = run(REEFLOG_BIN, ['tail', '--db', db, '--cursor', path.join(dir, 'c.txt'), '--limit', '100']);
  const seals = {};
  for (const line of tail.out.split('\n').filter(Boolean)) {
    try {
      const row = JSON.parse(line);
      seals[row.signature] = row.seal;
    } catch { /* not a row */ }
  }
  if (seals[VALID_SIG] !== 'finalized' || seals[REVERTED_SIG] !== 'reverted') {
    throw new Error(`reeflog did not mark the rows as expected: ${JSON.stringify(seals)}`);
  }
  return db;
}

/// Run the harvest tool once against a fresh journal and record what it said.
function measureOnce(tag, toolPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-harvest-retract-'));
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
    const json = JSON.stringify(doc);
    return {
      tag,
      exitCode: code,
      documentWritten: written,
      stderr: stderr.trim().split('\n').slice(-1)[0] ?? '',
      // The defect: a retracted signature reaching the payload sources.
      pinnedSignatures: doc ? doc.counts.pinnedSignatures : null,
      pinnedContainsRetracted: doc
        ? doc.signatures.some((s) => s.signature === REVERTED_SIG)
        : null,
      transactionContainsRetracted: doc
        ? doc.transactions.some((t) => t.signature === REVERTED_SIG)
        : null,
      // The contract the fix adds: named, always present.
      rowsReverted: doc && 'rowsReverted' in doc.counts ? doc.counts.rowsReverted : null,
      revertedSignaturesNamed: doc && Array.isArray(doc.counts.revertedSignatures)
        ? doc.counts.revertedSignatures.includes(REVERTED_SIG)
        : null,
      sealFieldPresent: written ? json.includes('seal') : null,
      rowsWithoutEnvelope: doc ? doc.counts.rowsWithoutEnvelope : null,
      networkAttempts: doc ? null : null,
      _raw: doc ? { counts: doc.counts, signatures: doc.signatures } : null,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- pre-fix tree: the same tool with the gate removed --------------------
const TOOL_ORIG = fs.readFileSync(TOOL, 'utf8');
const STASH = `${TOOL}.measure-bak`;

function prefixTool() {
  // Remove BOTH retraction gates — the measurement must be re-derivable
  // without relying on git state, and "pre-fix" here means the reader that
  // honoured neither signal: not the row's seal, not the channel.
  const mutated = TOOL_ORIG.replace(
    "  const revertedBySeal = row.seal === 'reverted';\n  const revertedByChannel = typeof row.signature === 'string' && reorgSignatures.has(row.signature);\n  if (revertedBySeal || revertedByChannel) {",
    '  const revertedBySeal = false;\n  const revertedByChannel = false;\n  if (revertedBySeal || revertedByChannel) {',
  );
  if (mutated === TOOL_ORIG) throw new Error('could not derive the pre-fix tool (gate not found)');
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
    face: 'P1_pinned_signatures_names_the_retracted_event',
    claim: 'the reader must not pin a signature the chain unmade',
    // `prefix`/`fixed` record whether the DEFECT is present in that tree
    // (true = the retracted event leaked into the payload sources). The
    // fixed tree must show it gone.
    prefix: prefix.pinnedContainsRetracted === true,
    fixed: fixed.pinnedContainsRetracted === true,
    detail: `prefix pinnedContainsRetracted=${prefix.pinnedContainsRetracted}, fixed=${fixed.pinnedContainsRetracted}`,
  },
  {
    face: 'P2_retracted_row_is_never_a_transaction',
    claim: 'no payload may be derived from a retracted event',
    prefix: prefix.transactionContainsRetracted === true,
    fixed: fixed.transactionContainsRetracted === true,
    detail: `prefix transactionContainsRetracted=${prefix.transactionContainsRetracted}, fixed=${fixed.transactionContainsRetracted}`,
  },
  {
    face: 'P3_the_retraction_is_named_in_the_document',
    claim: 'the withdrawn rows are reported, not silently dropped',
    // failure = the document does NOT name the retraction
    prefix: !(prefix.rowsReverted === 1 && prefix.revertedSignaturesNamed === true),
    fixed: !(fixed.rowsReverted === 1 && fixed.revertedSignaturesNamed === true),
    detail: `prefix rowsReverted=${prefix.rowsReverted} named=${prefix.revertedSignaturesNamed}; fixed rowsReverted=${fixed.rowsReverted} named=${fixed.revertedSignaturesNamed}`,
  },
  {
    face: 'P4_live_rows_are_still_harvested',
    claim: "failure = the fix dropped a live event too — the finalized row's own signature must stay a payload source",
    prefix: !prefix._raw.signatures.some((s) => s.signature === VALID_SIG),
    fixed: !fixed._raw.signatures.some((s) => s.signature === VALID_SIG),
    detail: `prefix signatures=${prefix._raw.signatures.map((s) => s.signature).join(',')}; fixed=${fixed._raw.signatures.map((s) => s.signature).join(',')}`,
  },
  {
    face: 'P5_the_retraction_is_not_an_open_envelope_debt',
    claim: 'failure = a row the chain forgot is counted as debt hydrate could ever close',
    prefix: prefix.rowsWithoutEnvelope !== 0,
    fixed: fixed.rowsWithoutEnvelope !== 0,
    detail: `prefix rowsWithoutEnvelope=${prefix.rowsWithoutEnvelope}, fixed=${fixed.rowsWithoutEnvelope}`,
  },
];

const defectPresent = faces.slice(0, 3).every((f) => f.prefix === true);
const defectGone = faces.slice(0, 3).every((f) => f.fixed === false);
const guardsHold = faces.slice(3).every((f) => f.prefix === false && f.fixed === false);

const verdict = (defectPresent && defectGone && guardsHold)
  ? 'reader-honours-retraction'
  : (defectPresent && !defectGone)
    ? 'reader-still-accepts-retracted-event'
    : 'no-verdict';

const artifact = {
  verdict,
  measuredAt: new Date().toISOString(),
  tool: 'tools/harvest-reeflog.mjs',
  method: 'real reeflog binary plants 1 finalized + 1 reverted enriched row; the repository harvest tool reads it with its zero-RPC guard; prefix = the same tool with both retraction gates (seal + reorg channel) removed',
  reeflogBinary: path.basename(REEFLOG_BIN),
  zeroRpcGuard: 'the tool imports tools/lib/network-guard.mjs first and exits 1 on any attempt (pinned by test/harvest-reeflog.test.mjs)',
  faces,
  prefix,
  fixed,
  limits: [
    'the probe is synthetic: a planted journal, not a fork observed on mainnet',
    'this artifact measures the SEAL half of the reader contract; the reorg CHANNEL (reorg tail, a separate cursor reeflog already provides) is polled by the same tool and measured separately in research/harvest-reorg-channel-2026-11-16.json',
    'one reverted row with a full envelope; other seal states covered by test/harvest-reeflog-retraction.test.mjs',
  ],
};

leakGuard(JSON.stringify(artifact));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(JSON.stringify({ out: OUT, verdict, faces: faces.map((f) => ({ face: f.face, prefix: f.prefix, fixed: f.fixed })) }, null, 2));
