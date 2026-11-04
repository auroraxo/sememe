// batch-pull.test.mjs — the measured acquisition gap is CLOSED, not believed.
//
// The gap artifact (research/acquisition-gap-2026-11-04.json) classified the
// foreign sweep's 306 no-interface payloads: 177 sit behind 34 programs that
// PUBLISH an on-chain IDL sememe never pulled. The card's next step was to
// pull them and re-measure. This file pins that acquisition and its
// falsification:
//
//   - T1 the batch tool does not exist on the pre-tree -> red (exit 2)
//   - T2 the candidates come FROM the gap artifact, its rows summed against
//        its own headline; a hand-edited row is refused before any probe
//   - T3 a pullable row is acquired and STORED through the same write path
//        `sememe pull` uses (receipt + object, offline-verifiable); a
//        publish-nothing row is NOT retried (pulling can never succeed)
//   - T4 an RPC failure is `unknown` and withholds the verdict — never an
//        absence, never a silent skip (the crates.io-403 lesson)
//   - T5 the committed acquisition artifact agrees with the committed
//        store: every stored row's fingerprint is present in the store and
//        re-hashes to its receipt (offline, no probe)
//   - T6 GREEN ON EVERY TREE: the closed sweep numbers move exactly by the
//        measured deltas — gap 306 -> 129, decoded 493 -> 661, and the
//        remaining refusals are named (16), not silent decodes. The pull did
//        NOT turn 177 payloads into decodes by itself: 152 decode with the
//        on-chain IDL, 25 refuse (deployed-newer discriminators and stale
//        layouts, named); 13 of the 34 programs ALSO have a first-party
//        published copy in the foreign repo (MIT), adopted next to the
//        pull, and the union path recovered 16 more payloads once two
//        naming differences stopped being misread as interface conflicts.
//
// Ladder measured 2026-11-04 on pre-tree 97cd8f8 (tool + artifacts absent):
// T1..T6 all RED — UNGUARDED on purpose, a skip guard would make the ladder
// look green without the fix. After the acquisition: all green, and the T6
// numbers are re-pinned from the measured artifact.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { canonicalJson } from '../src/canonical.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'batch-pull.mjs');
const GAP = path.join(ROOT, 'research', 'acquisition-gap-2026-11-04.json');
const ACQUIRED = path.join(ROOT, 'research', 'batch-pull-2026-11-04.json');
const BASE_STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04');
const PULLED_STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled');
const SWEEP_BASE = path.join(ROOT, 'research', 'step-ingestooor-full-sweep-2026-11-04.json');
const SWEEP_CLOSED = path.join(ROOT, 'research', 'step-ingestooor-full-sweep-pulled-2026-11-04.json');
const toolExists = existsSync(TOOL);
const gap = JSON.parse(await readFile(GAP, 'utf8'));

/** Run the tool; returns { code, stdout, stderr }. */
function runTool(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [TOOL, ...args], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}

/** Legacy anchor:idl account bytes carrying the given IDL (pull.test.mjs pattern). */
function anchorAccount(idl, program) {
  // `decodeAccount` inflates the body (compression byte 2 from the Anchor
  // header), so the fixture must store the DEFLATED bytes — inflating here
  // would hand the decoder plain JSON and every probe would read
  // `undecodable` (measured: the first draft of this helper did exactly that).
  const body = zlib.deflateSync(Buffer.from(JSON.stringify(idl)));
  const header = Buffer.alloc(44);
  Buffer.from([24, 70, 98, 191, 58, 144, 123, 158]).copy(header);
  header.writeUInt32LE(body.length, 40);
  // The owner of a legacy anchor:idl account is the PROGRAM itself — the
  // loader refuses any other owner by name.
  return {
    owner: program,
    data: [Buffer.concat([header, body]).toString('base64'), 'base64'],
  };
}

/** A fetcher answering getMultipleAccounts for the two derived addresses. */
function mockFetcher(rowsByProgram, slot = 77) {
  return async (url, init) => {
    const payload = JSON.parse(init.body);
    const keys = payload.params[0];
    const value = keys.map(() => null);
    for (const [program, accounts] of Object.entries(rowsByProgram)) {
      const { addresses } = await import('../src/acquire.mjs');
      const loc = await addresses(program);
      for (const [source, account] of Object.entries(accounts)) {
        const index = keys.indexOf(loc[source]);
        if (index >= 0) value[index] = account;
      }
    }
    return { ok: true, json: async () => ({ result: { context: { slot }, value } }) };
  };
}

const DCA = 'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M'; // pullable, 20 payloads
const L2 = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'; // publishes nothing, 42 payloads

test('T1: the batch acquisition tool exists and takes the gap artifact', async () => {
  const { code, stderr } = await runTool([]);
  assert.equal(code, 2, `usage refusal expected, got exit ${code}`);
  assert.match(stderr, /--gap/, 'the usage must name the gap artifact');
});

test('T2: candidates come from the gap artifact and a hand-edited row is refused', async () => {
  const { candidatesFromGap } = await import(TOOL);
  const candidates = candidatesFromGap(gap);
  assert.equal(candidates.length, 34, 'measured 2026-11-04: 34 pullable programs');
  assert.equal(candidates.reduce((n, c) => n + c.payloads, 0), 177, 'measured: 177 payloads behind them');
  assert.ok(candidates.some((c) => c.program === DCA), 'Jupiter DCA is one of them');
  assert.ok(!candidates.some((c) => c.program === L2), 'a publish-nothing program is never a candidate');
  const tampered = JSON.parse(JSON.stringify(gap));
  tampered.rows[0].payloads += 1;
  assert.throws(() => candidatesFromGap(tampered), /hand-edited/, 'a row edited against the headline must be refused');
});

test('T3: an acquired row is stored through the pull write path, offline-verifiable', async () => {
  const { acquire } = await import(TOOL);
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-batch-'));
  try {
    const idl = { instructions: [{ name: 'create_order', discriminator: [1, 2, 3, 4, 5, 6, 7, 8], args: [] }] };
    // Only a CANDIDATE reaches acquire (T2 is what keeps publish-nothing
    // programs out): here one pullable program, nothing else.
    const { rows, summary } = await acquire(
      [{ program: DCA, payloads: 20 }],
      { url: 'https://mock.invalid', fetcher: mockFetcher({ [DCA]: { anchor: anchorAccount(idl, DCA) } }), store },
    );
    const stored = rows.find((r) => r.program === DCA);
    assert.equal(stored?.verdict, 'stored');
    assert.equal(stored.source, 'anchor');
    assert.equal(stored.storedDiscriminators, 1);
    assert.equal(summary.stored, 1);
    assert.equal(summary.storedPayloads, 20, 'only the pullable payloads count as acquired');
    // The stored artifact is offline-verifiable exactly like a pull: receipt
    // + object, object re-hashes to the receipt's fingerprint.
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(path.join(store, 'receipts'));
    assert.equal(names.length, 1, 'one program, one receipt — no side writes');
    assert.match(names[0], new RegExp(`^${DCA}-77-anchor-`), 'the receipt binds program, slot and source');
    const receipt = JSON.parse(await readFile(path.join(store, 'receipts', names[0]), 'utf8'));
    const objectPath = path.join(store, 'objects', `${receipt.fingerprint.replace('sha256:', '')}.json`);
    const storedObject = JSON.parse(await readFile(objectPath, 'utf8'));
    const digest = createHash('sha256').update(`${canonicalJson(storedObject)}\n`).digest('hex');
    assert.equal(receipt.fingerprint, `sha256:${digest}`, 'the object must re-hash to its receipt');
    assert.equal(receipt.instructionCount, 1);
    assert.equal(stored.fingerprint, receipt.fingerprint, 'the artifact row and the receipt must agree');
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test('T4: an RPC failure is `unknown` and withholds the verdict, never an absence', async () => {
  const { acquire } = await import(TOOL);
  const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-batch-'));
  try {
    const failing = async () => { throw new Error('HTTP 403'); };
    const { rows, summary } = await acquire(
      [{ program: DCA, payloads: 20 }],
      { url: 'https://mock.invalid', fetcher: failing, store },
    );
    assert.equal(rows[0].verdict, 'unknown');
    assert.equal(summary.unknown, 1);
    assert.equal(summary.stored, 0);
    assert.equal(summary.verdict, 'no-verdict', 'a partial probe must not be quoted as a complete one');
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test('T5: the committed acquisition artifact agrees with the committed store (offline)', async () => {
  const artifact = JSON.parse(await readFile(ACQUIRED, 'utf8'));
  assert.equal(artifact.tool, 'batch-pull');
  assert.equal(artifact.summary.stored, 34, 'measured: all 34 pullable programs stored');
  assert.equal(artifact.summary.storedPayloads, 177, 'measured: 177 payloads behind them');
  assert.equal(artifact.summary.unknown, 0, 'the measurement was complete (no RPC failure)');
  assert.equal(artifact.summary.verdict, 'measured');
  for (const row of artifact.rows.filter((r) => r.verdict === 'stored')) {
    const fingerprint = row.fingerprint.replace('sha256:', '');
    const objectPath = path.join(PULLED_STORE, 'objects', `${fingerprint}.json`);
    const object = JSON.parse(await readFile(objectPath, 'utf8'));
    const digest = createHash('sha256').update(`${canonicalJson(object)}\n`).digest('hex');
    assert.equal(digest, fingerprint, `${row.program}: store object must re-hash to the artifact's fingerprint`);
    assert.ok(Array.isArray(object.instructions) && object.instructions.length === row.instructions,
      `${row.program}: stored instruction count must match the artifact`);
    const receipts = await (await import('node:fs/promises')).readdir(path.join(PULLED_STORE, 'receipts'));
    assert.ok(receipts.some((name) => name.startsWith(`${row.program}-`)),
      `${row.program}: a receipt must bind the program to the object`);
  }
});

test('T6: the closed sweep moved exactly by the measured deltas — and names what still refuses', async () => {
  const base = JSON.parse(await readFile(SWEEP_BASE, 'utf8'));
  const closed = JSON.parse(await readFile(SWEEP_CLOSED, 'utf8'));
  // The store changed; the document set did not.
  assert.equal(closed.summary.payloadsChecked, base.summary.payloadsChecked);
  assert.equal(closed.summary.missingBytes, base.summary.missingBytes);
  assert.equal(closed.summary.transactionsChecked, base.summary.transactionsChecked);
  assert.equal(closed.networkAttempts, 0);
  // Measured deltas (2026-11-04, same tool, only the store augmented):
  assert.equal(base.summary.noInterface, 306);
  assert.equal(closed.summary.noInterface, 129, 'gap: 306 -> 129 (177 payloads behind pullable programs)');
  assert.equal(base.summary.decoded, 493);
  assert.equal(closed.summary.decoded, 661, 'decoded: 493 -> 661 (152 from the on-chain pull, 16 more through the union with adopted first-party copies)');
  assert.equal(closed.summary.disagreements, 0, 'still diff-free: every decode re-encodes byte-exactly');
  assert.equal(closed.summary.decodeErrors, 16, 'the remaining refusals are named (7 pre-existing + 9 of the 25, after the naming fix); none are silent decodes');
  // The four programs whose pulled IDL cannot decode the fixture wire are
  // REFUSED BY NAME — an honest pull, not a coverage claim.
  const byProgram = closed.summary.byProgram;
  for (const [program, errors] of [
    ['FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn', 2],
    ['6m2CDdhRgxpH4WjvdzxAYbGxwdGUz5MziiL5jek2kBma', 4],
    ['REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3', 1],
    ['pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', 1],
  ]) {
    assert.equal(byProgram[program]?.decodeErrors, errors,
      `${program}: the pulled IDL must refuse these payloads by name`);
    assert.equal(byProgram[program]?.noInterface, 0,
      `${program}: it is no longer an acquisition gap — it has an interface that refuses`);
  }
  // Programs closed by the union with the adopted first-party copy:
  // on-chain refuses (deployed-newer), the published copy answers.
  for (const [program, decoded] of [
    ['FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn', 10],
    ['EHBN9YKtMmrZhj8JZqyBQRGqyyeHw5xUB1Q5eAHszuMt', 10],
    ['DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M', 20],
  ]) {
    assert.equal(byProgram[program]?.decoded, decoded,
      `${program}: union with the first-party copy must decode these`);
  }
});

test('G1 false-positive guard: the BASE sweep artifact still holds the old numbers', async () => {
  // The augmented store must not silently rewrite history: the committed
  // baseline artifact keeps the pre-pull measurement.
  const base = JSON.parse(await readFile(SWEEP_BASE, 'utf8'));
  assert.equal(base.summary.noInterface, 306);
  assert.equal(base.summary.decoded, 493);
  assert.equal(base.summary.decodeErrors, 7);
});
