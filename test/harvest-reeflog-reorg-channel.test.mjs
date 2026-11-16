// The reader must ask the channel that carries retractions, not only the seal
// on the row it happens to be reading.
//
// reeflog delivers two signals for one fact (`src/main.rs`, `run_reorg_tail`):
// `tail` prints the row's CURRENT seal, `reorg tail` prints the retraction
// itself — "a consumer that already read an event cannot learn about its
// retraction from the event stream: the event keeps its seq and is delivered
// exactly once". The seal is a snapshot taken when the row is read; a
// retraction recorded AFTER that read never appears in it. That is precisely
// why the second channel exists, and the harvest tool (before this pulse)
// only read the first.
//
// Measured shape of the gap: one journal row whose `seal` still says
// `finalized` while `reorg tail` carries `reorg_id 7` for its signature —
// i.e. the chain unmade the event between the row read and the channel read.
//
//   counts.pinnedSignatures = 2      (the retracted row was pinned)
//   counts.reorgRetractions  = absent (the channel was never asked)
//
// The contract these tests pin:
//   * a signature the retraction channel names is NEVER a transaction,
//     signature or payload — whatever the row's seal says;
//   * the row is NAMED, and it is distinguishable from a seal-only
//     retraction (`reorgOnlySignatures`), so a reader can tell "the row said
//     so" from "the channel said so after the fact";
//   * the channel's own delivery is counted (`reorgRetractions`);
//   * a channel that cannot be READ fails the run — a document that claims a
//     retraction was honoured without asking the channel is the same defect
//     in a second shape;
//   * the two channels use SEPARATE cursor files (reeflog refuses a cursor
//     written by the other channel);
//   * guards on both trees: no channel record and no seal means an ordinary
//     harvest, and the seal gate still works when the channel is silent.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const DATA_A = '3Bvo8NsR';
const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'harvest-reeflog.mjs');

function sealRow(signature, slot, seal) {
  const row = {
    signature, slot, err: null, source: 'ws', first_seen: 1700000000000,
    accounts: {
      program_id: WHIRLPOOL,
      err: null,
      instructions: [
        { inner: false, outer: 0, program_id: WHIRLPOOL, accounts: [], data: DATA_A },
      ],
    },
    account_state: null,
    logs: ['Program log: hi'],
    payload_state: null,
  };
  if (seal !== undefined) row.seal = seal;
  return JSON.stringify(row);
}

function reorgRow(reorgId, signature, slot, detail = 'both sources refused') {
  return JSON.stringify({
    reorg_id: reorgId, signature, slot, detected_at: 1700000000000,
    status_source: 'status', tx_source: 'tx', detail,
  });
}

/// A fake reeflog that answers the TWO channels differently. `args` is the
/// first word on the command line: the tool spawns `tail …` and `reorg tail …`.
/// `failReorg` makes only the retraction channel exit non-zero.
function fakeReeflog(dir, { events = [], reorgs = [], failReorg = false, logPath = null } = {}) {
  const bin = path.join(dir, 'reeflog-fake');
  const logger = logPath ? `echo "$*" >> '${logPath}'\n` : '';
  fs.writeFileSync(bin, `#!/bin/sh
${logger}if [ "$1" = "reorg" ]; then
  if [ "${failReorg ? 'yes' : 'no'}" = "yes" ]; then
    echo "reeflog: error: journal is locked" >&2
    exit 1
  fi
  exec cat <<'REEFLOG_FAKE_REORG_EOF'
${reorgs.join('\n')}
REEFLOG_FAKE_REORG_EOF
fi
exec cat <<'REEFLOG_FAKE_EOF'
${events.join('\n')}
REEFLOG_FAKE_EOF
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function run(dir, bin, extra = []) {
  const db = path.join(dir, 'j.db');
  fs.writeFileSync(db, 'placeholder');
  const out = path.join(dir, 'harvest.json');
  const stdout = execFileSync(process.execPath, [
    TOOL, '--db', db, '--out', out, '--reeflog-bin', bin, ...extra,
  ], { encoding: 'utf8' });
  return {
    doc: JSON.parse(fs.readFileSync(out, 'utf8')),
    report: JSON.parse(stdout),
    out,
  };
}

function runFailure(dir, bin) {
  const db = path.join(dir, 'j.db');
  fs.writeFileSync(db, 'placeholder');
  const out = path.join(dir, 'harvest.json');
  let code = 0, stderr = '';
  try {
    execFileSync(process.execPath, [TOOL, '--db', db, '--out', out, '--reeflog-bin', bin], { encoding: 'utf8' });
  } catch (error) {
    code = error.status;
    stderr = String(error.stderr);
  }
  return { code, stderr, out };
}

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-harvest-reorg-'));

// --- D: the defect ---------------------------------------------------------

test('D1: a signature the channel retracts is never a payload source, whatever the seal says', () => {
  const dir = freshDir();
  const bin = fakeReeflog(dir, {
    events: [
      sealRow('VALIDSIG', 100, 'finalized'),
      // The row still says finalized: the retraction arrived AFTER this row
      // was read. Only the channel knows.
      sealRow('LATERETRACTED', 101, 'finalized'),
    ],
    reorgs: [reorgRow(7, 'LATERETRACTED', 101)],
  });
  const { doc } = run(dir, bin);

  assert.equal(doc.counts.journalRows, 2, 'the denominator still counts every row');
  assert.equal(doc.counts.pinnedSignatures, 1, 'the channel-retracted row must not be pinned');
  assert.ok(
    !doc.transactions.some((t) => t.signature === 'LATERETRACTED'),
    `a channel-retracted event must not be a payload source; got ${JSON.stringify(doc.transactions.map((t) => t.signature))}`,
  );
  assert.ok(
    !doc.signatures.some((s) => s.signature === 'LATERETRACTED'),
    'the pinned signature list must not carry a channel-retracted signature',
  );
  assert.equal(doc.counts.payloads, 1, 'only the live row contributes a payload');
});

test('D2: the channel-retracted row is NAMED and distinguishable from a seal retraction', () => {
  const dir = freshDir();
  const bin = fakeReeflog(dir, {
    events: [
      sealRow('VALIDSIG', 100, 'finalized'),
      sealRow('SEALREVERTED', 101, 'reverted'),
      sealRow('LATERETRACTED', 102, 'finalized'),
    ],
    reorgs: [
      reorgRow(7, 'SEALREVERTED', 101),
      reorgRow(8, 'LATERETRACTED', 102),
    ],
  });
  const { doc } = run(dir, bin);

  assert.equal(doc.counts.rowsReverted, 2, 'both retractions are their own debt');
  assert.deepEqual(
    [...doc.counts.revertedSignatures].sort(),
    ['LATERETRACTED', 'SEALREVERTED'],
    'named, not silently dropped',
  );
  assert.deepEqual(
    doc.counts.reorgOnlySignatures,
    ['LATERETRACTED'],
    'a retraction only the channel knew about is separable from a seal-only one',
  );
  assert.equal(doc.counts.reorgRetractions, 2, "the channel's own delivery is counted");
  assert.equal(doc.counts.rowsWithoutEnvelope, 0, 'a retraction is not an envelope debt');
});

test('D3: the counters are always present even when the channel delivers nothing', () => {
  const dir = freshDir();
  const bin = fakeReeflog(dir, { events: [sealRow('VALIDSIG', 100, 'finalized')] });
  const { doc } = run(dir, bin);

  assert.equal(doc.counts.reorgRetractions, 0, 'an empty channel is a counted zero');
  assert.deepEqual(doc.counts.reorgOnlySignatures, [], 'empty list, never an absent key');
  assert.deepEqual(doc.counts.revertedSignatures, []);
  assert.equal(doc.counts.rowsReverted, 0);
});

test('D6: the channel delivery is counted, and a channel-only retraction is separable', () => {
  const dir = freshDir();
  const bin = fakeReeflog(dir, {
    events: [sealRow('VALIDSIG', 100, 'finalized')],
    reorgs: [reorgRow(9, 'NOTINTHISREAD', 42)],
  });
  const { doc } = run(dir, bin);
  assert.equal(doc.counts.reorgRetractions, 1, "the channel's delivery is counted even for an unknown row");
  assert.deepEqual(doc.counts.reorgOnlySignatures, [], 'only rows this read returned are named per-row');
});

/// The document must SAY that both channels were read — otherwise a reader
/// cannot tell this document from one produced by a tool that never asked.
test('D4: the method names both channels', () => {
  const dir = freshDir();
  const bin = fakeReeflog(dir, { events: [sealRow('VALIDSIG', 100, 'finalized')] });
  const { doc, report } = run(dir, bin);
  assert.match(doc.method, /reeflog tail --cursor/);
  assert.match(doc.method, /reorg tail --cursor/, 'the retraction channel must be part of the method');
  assert.equal(report.networkAttempts, 0, 'still zero RPC');
});

// --- F: a channel that cannot be read fails the run -------------------------

test('F1: an unreadable retraction channel refuses to write a document', () => {
  const dir = freshDir();
  const bin = fakeReeflog(dir, {
    events: [sealRow('VALIDSIG', 100, 'finalized')],
    failReorg: true,
  });
  const { code, stderr, out } = runFailure(dir, bin);

  assert.equal(code, 1, 'the run must fail, not silently downgrade');
  assert.match(stderr, /retraction channel/i, 'the refusal must name the channel');
  assert.equal(fs.existsSync(out), false, 'no document that claims a honoured retraction');
});

// --- C: the two channels keep separate cursors ------------------------------

test('C1: the tool opens one cursor file per channel', () => {
  const dir = freshDir();
  const logPath = path.join(dir, 'spawn.log');
  const bin = fakeReeflog(dir, {
    events: [sealRow('VALIDSIG', 100, 'finalized')],
    reorgs: [reorgRow(7, 'OTHERSIG', 105)],
    logPath,
  });
  run(dir, bin);

  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'both channels were asked');
  assert.ok(lines[0].startsWith('tail '), `first call is tail: ${lines[0]}`);
  assert.ok(lines[1].startsWith('reorg tail '), `second call is reorg tail: ${lines[1]}`);
  const cursorOf = (line) => {
    const parts = line.split(' ');
    return parts[parts.indexOf('--cursor') + 1];
  };
  const eventCursor = cursorOf(lines[0]);
  const reorgCursor = cursorOf(lines[1]);
  assert.ok(eventCursor && reorgCursor, 'both calls name a cursor file');
  assert.notEqual(eventCursor, reorgCursor, 'one file per channel — reeflog refuses a mixed one');
});

// --- G: guards that must stay green on BOTH trees ---------------------------

test('G1: a channel that names a signature this journal does not hold invents no transaction', () => {
  // The reorg channel has its own cursor: it can carry retractions for rows
  // this read did not return (already consumed, or outside the limit). They
  // never invent a transaction.
  const dir = freshDir();
  const bin = fakeReeflog(dir, {
    events: [sealRow('VALIDSIG', 100, 'finalized')],
    reorgs: [reorgRow(9, 'NOTINTHISREAD', 42)],
  });
  const { doc } = run(dir, bin);
  assert.equal(doc.counts.pinnedSignatures, 1, 'the live row still harvests');
  assert.equal(doc.transactions.length, 1);
  assert.ok(
    !doc.transactions.some((t) => t.signature === 'NOTINTHISREAD'),
    'a retraction for a row this read never returned must not create one',
  );
});

test('G2: no channel record and no seal means an ordinary harvest (the reader never invents a retraction)', () => {
  const dir = freshDir();
  const bin = fakeReeflog(dir, {
    events: [
      sealRow('NOSEAL', 100),
      sealRow('NULLSEAL', 101, null),
      sealRow('CONFIRMED', 102, 'confirmed'),
    ],
  });
  const { doc } = run(dir, bin);
  assert.equal(doc.counts.journalRows, 3);
  assert.equal(doc.counts.pinnedSignatures, 3, 'every ordinary row is still a payload source');
  assert.equal(doc.counts.payloads, 3);
  assert.equal(doc.counts.rowsReverted, 0, 'no retraction was invented');
});

test('G3: the seal gate still works when the channel is silent', () => {
  const dir = freshDir();
  const bin = fakeReeflog(dir, {
    events: [
      sealRow('VALIDSIG', 100, 'finalized'),
      sealRow('SEALREVERTED', 101, 'reverted'),
    ],
  });
  const { doc } = run(dir, bin);
  assert.equal(doc.counts.rowsReverted, 1);
  assert.deepEqual(doc.counts.revertedSignatures, ['SEALREVERTED']);
  assert.equal(doc.counts.pinnedSignatures, 1);
  assert.ok(!doc.transactions.some((t) => t.signature === 'SEALREVERTED'));
});

test('D5: a journal whose rows are ALL channel-retracted cannot become a success document', () => {
  const dir = freshDir();
  const bin = fakeReeflog(dir, {
    events: [sealRow('LATERETRACTED', 101, 'finalized')],
    reorgs: [reorgRow(7, 'LATERETRACTED', 101)],
  });
  const { code, stderr, out } = runFailure(dir, bin);
  assert.equal(code, 1, 'a harvest of nothing must not look successful');
  assert.match(stderr, /retract/i, 'the refusal must say WHY nothing was harvestable');
  assert.equal(fs.existsSync(out), false, 'no success document is written');
});
