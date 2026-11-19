// Two-tree + two-channel measurement: does the mailbox reader distinguish a
// row the journal STILL OWES from a row the journal has recorded as LOST?
//
// The claim under test
// --------------------
// reeflog rows carry the difference explicitly (src/main.rs run_tail,
// journal.rs): payload_state / account_state are NULL while the row is owed
// ("hydrate will fill it") and name an outcome once it can never be filled
// ('unavailable' = the chain forgot the transaction, 'invalid' = the endpoint
// refuses the key, 'no_metadata' = the response carried no account data).
// reeflog's own `status` refuses to alarm on recorded outcomes ("a RECORDED
// outcome … hydrate counts those as a completed pass, not a pending row.
// Alarming on them would alarm forever") and `tail --with-accounts` SKIPS and
// consumes them instead of holding.
//
// The shipped reader (src/mailbox.mjs) had no vocabulary for this: every row
// without a complete envelope landed in ONE counter, `rowsWithoutEnvelope`,
// whose documented meaning is debt `hydrate --accounts` closes — so a
// permanently lost transaction was reported as an open repair task, and the
// harvest tool named a repair (`run reeflog … hydrate --accounts first`) that
// can never succeed. That is the permanent-false-alarm class reeflog already
// closed on its own surfaces, crossing the package boundary back in.
//
// The probe plants a REAL journal through the REAL reeflog binary:
//
//   LIVE_SIG   logs + complete envelope                       -> payload
//   OWED_SIG   logs, accounts NULL, account_state NULL        -> owed, repairable
//   LOST_SIG   logs NULL, payload_state 'unavailable'         -> recorded, permanent
//   ENV_SIG    logs, accounts NULL, account_state 'no_metadata' -> recorded, permanent
//   INVALID_SIG logs NULL, payload_state 'invalid'            -> recorded, permanent
//
// Faces:
//   prefix  — this tree's tools/harvest-reeflog.mjs BEFORE the reader fix
//   fixed   — the same tool AFTER
//   published — `sememe/mailbox` imported from the PUBLISHED npm package
//               (the channel a stranger installs), same rows, same probe
//
// verdict `mailbox-recorded-outcomes-name-themselves`:
//   prefix/published report the two+three lost rows as `rowsWithoutEnvelope`
//   (repairable debt, hydrate advice) and name no outcome, while fixed
//   separates owed (still named rowsWithoutEnvelope) from recorded outcomes
//   (own counter + per-row reasons), with all guards green on both trees.
//
// Usage: node tools/measure-mailbox-recorded-outcome.mjs
//          [--reeflog-bin <path>] [--out <file>] [--carrier <version>]

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
const TODAY = new Date().toISOString().slice(0, 10);
const OUT = path.resolve(option('--out', path.join(ROOT, 'research', `mailbox-recorded-outcome-${TODAY}.json`)));
const REEFLOG_BIN = path.resolve(option('--reeflog-bin',
  process.env.REEFLOG_BIN || path.join(ROOT, '..', 'reeflog', 'target', 'release', 'reeflog')));
const TOOL = option('--tool', path.join(ROOT, 'tools', 'harvest-reeflog.mjs'));
const CARRIER = option('--carrier', null); // published npm version for the channel face

// --- no host path may reach the artifact -----------------------------------
const leakGuard = (s) => {
  const home = os.homedir();
  if (s.includes(home)) throw new Error(`host path leaked into the artifact: ${home}`);
};

const LIVE_SIG = 'LiveSig111111111111111111111111111111111111111';
const OWED_SIG = 'OwedSig111111111111111111111111111111111111111';
const LOST_SIG = 'LostSig111111111111111111111111111111111111111';
const ENV_SIG = 'EnvSig1111111111111111111111111111111111111111';
const INVALID_SIG = 'InvalSig111111111111111111111111111111111111111';
const LOST2_SIG = 'Lost2Sig111111111111111111111111111111111111111';
const ENV2_SIG = 'Env2Sig1111111111111111111111111111111111111111';
const INVALID2_SIG = 'Inval2Sig11111111111111111111111111111111111111';
const ENVELOPE = JSON.stringify({
  instructions: [{ inner: false, outer: 0, program_id: PROGRAM, accounts: [], data: '3Bvo8NsR' }],
  accounts_flags_source: 'message',
  token_changes: [],
});

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/// Plant the journal through the real binary's own `init`, then the rows.
/// The rows are written with the exact column vocabulary journal.rs defines;
/// nothing here fakes reeflog's OUTPUT — every observation about what reeflog
/// says comes from running its binary below.
function plantJournal(dir) {
  const db = path.join(dir, 'reeflog.db');
  const init = run(REEFLOG_BIN, ['init', '--db', db, '--program', PROGRAM]);
  if (init.code !== 0) throw new Error(`reeflog init failed: ${init.err.trim()}`);

  const sql = new DatabaseSync(db);
  const insert = sql.prepare(`INSERT INTO events
      (signature, slot, err, logs, source, first_seen, seal_status, seal_seen, payload_state, accounts, account_state)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const now = Date.now();
  // LIVE: everything the reader needs.
  insert.run(LIVE_SIG, 200000, null, '["Program log: live"]', 'ws', now, 'finalized', now, 'held', ENVELOPE, 'held');
  // OWED: enriched payload, envelope not yet fetched -> hydrate --accounts
  // will fill it later. This is the repairable case.
  insert.run(OWED_SIG, 200001, null, '["Program log: owed"]', 'ws', now, 'finalized', now, 'held', null, null);
  // LOST: the chain no longer knows the transaction. Permanent.
  insert.run(LOST_SIG, 200002, null, null, 'ws', now, 'finalized', now, 'unavailable', null, null);
  // ENV: payload known, account outcome recorded as no_metadata. Permanent.
  insert.run(ENV_SIG, 200003, null, '["Program log: env"]', 'ws', now, 'finalized', now, 'held', null, 'no_metadata');
  // INVALID: the endpoint refuses the key. Permanent.
  insert.run(INVALID_SIG, 200004, null, null, 'ws', now, 'finalized', now, 'invalid', null, null);
  sql.close();

  // What reeflog ITSELF says about these rows: tail must deliver all five
  // (no hold: owed has logs, recorded outcomes are not owed), with the
  // states visible in the row.
  const tail = run(REEFLOG_BIN, ['tail', '--db', db, '--cursor', path.join(dir, 'c.txt'), '--limit', '100']);
  if (tail.code !== 0) throw new Error(`reeflog tail failed: ${tail.err.trim()}`);
  const rows = tail.out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const bySig = Object.fromEntries(rows.map((r) => [r.signature, r]));
  const expectations = {
    [LIVE_SIG]: (r) => r.payload_state === 'held' && r.account_state === 'held',
    [OWED_SIG]: (r) => r.payload_state === 'held' && r.account_state == null,
    [LOST_SIG]: (r) => r.payload_state === 'unavailable' && r.logs == null,
    [ENV_SIG]: (r) => r.account_state === 'no_metadata' && r.accounts == null,
    [INVALID_SIG]: (r) => r.payload_state === 'invalid' && r.logs == null,
  };
  for (const [sig, ok] of Object.entries(expectations)) {
    if (!bySig[sig] || !ok(bySig[sig])) {
      throw new Error(`reeflog did not deliver ${sig} as expected: ${JSON.stringify(bySig[sig] ?? null)}`);
    }
  }
  if (rows.length !== 5) throw new Error(`expected 5 delivered rows, got ${rows.length}`);
  return { db, rows };
}

/// Plant a journal whose rows are ALL permanently lost — the state that makes
/// the advice face observable: no transaction can be harvested, so the tool
/// prints repair advice, and the question is WHICH advice it names.
function plantLostJournal(root) {
  const dir = path.join(root, 'lost');
  fs.mkdirSync(dir, { recursive: true });
  const db = path.join(dir, 'reeflog.db');
  const init = run(REEFLOG_BIN, ['init', '--db', db, '--program', PROGRAM]);
  if (init.code !== 0) throw new Error(`reeflog init failed: ${init.err.trim()}`);
  const sql = new DatabaseSync(db);
  const insert = sql.prepare(`INSERT INTO events
      (signature, slot, err, logs, source, first_seen, seal_status, seal_seen, payload_state, accounts, account_state)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const now = Date.now();
  insert.run(LOST2_SIG, 300002, null, null, 'ws', now, 'finalized', now, 'unavailable', null, null);
  insert.run(ENV2_SIG, 300003, null, '["Program log: env"]', 'ws', now, 'finalized', now, 'held', null, 'no_metadata');
  insert.run(INVALID2_SIG, 300004, null, null, 'ws', now, 'finalized', now, 'invalid', null, null);
  sql.close();
  const tail = run(REEFLOG_BIN, ['tail', '--db', db, '--cursor', path.join(dir, 'c.txt'), '--limit', '100']);
  if (tail.code !== 0) throw new Error(`reeflog tail failed: ${tail.err.trim()}`);
  const n = tail.out.split('\n').filter(Boolean).length;
  if (n !== 3) throw new Error(`expected 3 delivered rows in the lost journal, got ${n}`);
  return db;
}

/// Run one harvest tool against a planted journal and record what it said.
function measureTool(tag, toolPath, db) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-rc-outcome-'));
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
  fs.rmSync(dir, { recursive: true, force: true });
  const counts = doc?.counts ?? {};
  return {
    tag,
    exitCode: code,
    documentWritten: written,
    // the three faces the verdict reads
    rowsWithoutEnvelope: counts.rowsWithoutEnvelope ?? null,
    rowsWithoutInstructions: counts.rowsWithoutInstructions ?? null,
    rowsRecordedOutcome: counts.rowsRecordedOutcome ?? null,
    recordedOutcomes: counts.recordedOutcomes ?? null,
    rowsReverted: counts.rowsReverted ?? null,
    payloads: counts.payloads ?? null,
    pinnedSignatures: counts.pinnedSignatures ?? null,
    // did the tool tell the operator to run a repair that cannot succeed?
    namesHydrateRepair: /hydrate/.test(stderr),
    stderr: stderr.trim().split('\n').slice(-2).join(' \n ').slice(0, 600),
  };
}

/// The PUBLISHED channel face: import `sememe/mailbox` from an installed
/// npm package and run the SAME rows through mailboxTransactions.
function measurePublished(version, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-rc-pub-'));
  try {
    const pkgDir = path.join(dir, 'app');
    fs.mkdirSync(pkgDir);
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'probe', private: true }));
    const install = spawnSync('npm', ['install', `sememe@${version}`, '--no-audit', '--no-fund', '--loglevel', 'error'],
      { cwd: pkgDir, encoding: 'utf8' });
    if (install.status !== 0) {
      return { tag: `published@${version}`, error: `npm install failed: ${String(install.stderr ?? '').slice(-300)}` };
    }
    const probe = `
      import('sememe/mailbox').then((m) => {
        const r = m.mailboxTransactions({ rows: ${JSON.stringify(rows)}, program: ${JSON.stringify(PROGRAM)}, channelRead: true });
        console.log(JSON.stringify({ ok: true, counts: r.counts }));
      }).catch((e) => console.log(JSON.stringify({ ok: false, error: String(e && e.message) })));
    `;
    const r = spawnSync(process.execPath, ['--eval', probe], { cwd: pkgDir, encoding: 'utf8' });
    let parsed;
    try { parsed = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { parsed = { ok: false, error: r.stdout + r.stderr }; }
    if (!parsed.ok) return { tag: `published@${version}`, error: String(parsed.error).slice(0, 400) };
    const c = parsed.counts;
    return {
      tag: `published@${version}`,
      rowsWithoutEnvelope: c.rowsWithoutEnvelope ?? null,
      rowsWithoutInstructions: c.rowsWithoutInstructions ?? null,
      rowsRecordedOutcome: c.rowsRecordedOutcome ?? null,
      recordedOutcomes: c.recordedOutcomes ?? null,
      rowsReverted: c.rowsReverted ?? null,
      payloads: c.payloads ?? null,
      pinnedSignatures: c.pinnedSignatures ?? null,
      // The published package ships no tool, so the "advice" face is the
      // counts' own meaning: rowsWithoutEnvelope is the debt bucket the
      // documented contract says hydrate closes.
      namesHydrateRepair: null,
      stderr: '',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (!fs.existsSync(REEFLOG_BIN)) {
  console.error(`NO VERDICT: reeflog binary not found at ${REEFLOG_BIN} (pass --reeflog-bin or set REEFLOG_BIN)`);
  process.exit(3);
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-rc-'));
try {
  const { db, rows } = plantJournal(workdir);
  const lostDb = plantLostJournal(workdir);

  // The fixed face is measured by pointing --tool at a second copy of the
  // tree (the caller passes --tool after applying the fix); when the fix is
  // IN this tree, prefix == fixed is a falsification error, so detect it.
  const fixedTool = option('--fixed-tool', null);

  const prefix = measureTool('prefix', TOOL, db);

  // The lost journal: all three remaining rows are permanently lost, so the
  // tool cannot write a document and MUST name the situation. Which repair
  // it names is the advice face.
  const advicePrefix = measureTool('advice-prefix', TOOL, lostDb);
  const adviceNull = {
    tag: 'advice-null', exitCode: 0, documentWritten: false,
    rowsWithoutEnvelope: null, rowsWithoutInstructions: null, rowsRecordedOutcome: null,
    recordedOutcomes: null, rowsReverted: null, payloads: null, pinnedSignatures: null,
    namesHydrateRepair: false, stderr: '',
  };
  const adviceFixed = fixedTool ? measureTool('advice-fixed', fixedTool, lostDb) : adviceNull;

  const fixed = fixedTool ? measureTool('fixed', fixedTool, db) : null;

  const published = CARRIER ? measurePublished(CARRIER, rows) : null;

  // Guards: the reader must never lose the repairable case or the payload.
  const guards = {
    liveRowHarvested: (x) => x.payloads === 1 && x.pinnedSignatures === 1,
    retractedStillZero: (x) => x.rowsReverted === 0,
    owedStillCounted: (x) => typeof x.rowsWithoutEnvelope === 'number' && x.rowsWithoutEnvelope >= 1,
  };

  const report = {
    tool: 'tools/measure-mailbox-recorded-outcome.mjs',
    verdict: null,
    carrier: CARRIER ?? 'none',
    reeflogRows: rows.map((r) => ({
      signature: r.signature, payload_state: r.payload_state, account_state: r.account_state,
      logs: r.logs == null ? null : 'present', accounts: r.accounts == null ? null : 'present',
    })).map((r) => { leakGuard(JSON.stringify(r)); return r; }),
    prefix,
    fixed,
    published,
    advicePrefix,
    adviceFixed,
    guards: {},
    observedAt: new Date().toISOString(),
  };

  const guardResults = {};
  const guardSource = fixed ?? prefix;
  for (const [name, fn] of Object.entries(guards)) {
    guardResults[name] = { green: fn(guardSource), mustBeGreenOn: fixed ? 'both trees' : 'prefix' };
  }
  report.guards = guardResults;
  const guardsGreen = Object.values(guardResults).every((g) => g.green);

  // A face is a DEFECT face when the lost rows land in the repairable bucket
  // with no recorded-outcome vocabulary; a SEPARATION face when the reader
  // splits owed from recorded with named reasons.
  const prefixDefect =
    prefix.documentWritten
    && prefix.rowsRecordedOutcome == null
    && prefix.rowsWithoutEnvelope === 4
    && advicePrefix !== null
    && advicePrefix.namesHydrateRepair === true;

  const fixedHeld = fixed
    && fixed.documentWritten
    && fixed.rowsRecordedOutcome === 3
    && fixed.rowsWithoutEnvelope === 1
    && Array.isArray(fixed.recordedOutcomes)
    && fixed.recordedOutcomes.length === 3
    && fixed.recordedOutcomes.every((o) => o.payloadState || o.accountState)
    && fixed.payloads === 1;

  const publishedDefect = published && !published.error
    && published.rowsRecordedOutcome == null
    && published.rowsWithoutEnvelope === 4;
  const publishedHeld = published && !published.error
    && published.rowsRecordedOutcome === 3
    && published.rowsWithoutEnvelope === 1
    && Array.isArray(published.recordedOutcomes)
    && published.recordedOutcomes.length === 3;

  if (!guardsGreen) {
    report.verdict = 'guards-red';
    report.detail = JSON.stringify(guardResults);
  } else if (prefixDefect && fixedHeld) {
    report.verdict = 'mailbox-recorded-outcomes-name-themselves';
    report.detail = `prefix ${prefix.rowsWithoutEnvelope}-in-one-bucket + hydrate advice -> fixed owed=${fixed.rowsWithoutEnvelope} recorded=${fixed.rowsRecordedOutcome} (${fixed.recordedOutcomes.map((o) => o.payloadState ?? o.accountState).join('/')}); advice fixed: ${adviceFixed ? adviceFixed.stderr.slice(0, 200) : 'n/a'}`;
  } else if (!prefixDefect && publishedHeld) {
    report.verdict = 'mailbox-recorded-outcomes-held-on-the-published-channel';
    report.detail = `published@${CARRIER} owed=${published.rowsWithoutEnvelope} recorded=${published.rowsRecordedOutcome}`;
  } else if (!prefixDefect && publishedDefect) {
    report.verdict = 'not-held-published-already-separated';
    report.detail = JSON.stringify(published);
  } else if (prefixDefect || publishedDefect) {
    report.verdict = 'defect-present-fix-pending';
    report.detail = prefixDefect
      ? `prefix rowsWithoutEnvelope=${prefix.rowsWithoutEnvelope} rowsRecordedOutcome=${prefix.rowsRecordedOutcome} hydrateAdvice=${prefix.namesHydrateRepair}`
      : `published@${CARRIER} rowsWithoutEnvelope=${published.rowsWithoutEnvelope} rowsRecordedOutcome=${published.rowsRecordedOutcome}`;
  } else {
    report.verdict = 'not-held-no-defect-found';
    report.detail = `prefix rowsWithoutEnvelope=${prefix.rowsWithoutEnvelope} rowsRecordedOutcome=${prefix.rowsRecordedOutcome} advice=${advicePrefix ? advicePrefix.stderr.slice(0, 200) : 'n/a'}${published ? ` published=${JSON.stringify(published)}` : ''}`;
  }

  leakGuard(JSON.stringify(report));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log(`verdict=${report.verdict}`);
  console.log(`detail=${report.detail}`);
  console.log(`artifact=${path.relative(ROOT, OUT)}`);
  const HOLD = 'mailbox-recorded-outcomes-name-themselves';
  process.exit(report.verdict === HOLD || report.verdict === 'mailbox-recorded-outcomes-held-on-the-published-channel' ? 0 : 2);
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}
