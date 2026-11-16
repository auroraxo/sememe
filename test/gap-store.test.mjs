// gap-store.test.mjs — `sememe gap` must answer with the LOCAL store in view, not the chain alone.
//
// WHY (measured 2026-11-16 from a stranger's install of the PUBLISHED
// sememe@0.4.29 into an empty app, fixture store copied to ~/.sememe): the
// usage defines `pullable` as "an interface exists on chain that this
// program's store simply does not have yet" — but the implementation never
// read a store (bin/sememe.mjs called probe([{ program, payloads: 0 }]) with no
// storeDir), so two OPPOSITE worlds produced IDENTICAL output:
//   - whirLb...  store HOLDS the pulled receipt       -> verdict pullable,
//     next "sememe pull whirLb..."   (the pull it already ran)
//   - L2TExM...  store HOLDS the adopted first-party  -> verdict
//     no-interface-published, next "... use sememe adopt-lighthouse ..." — the
//     copy the store already owns
// A stranger was advised to redo both acquisitions, and the JSON carried a
// `payloads: 0` line that no probe had ever measured.
//
// Ladder (ALL tests UNGUARDED, so they run RED on the pre-fix tree too — a
// skip guard would make the ladder look green without the fix):
//   T1 CLI: `--store` is a declared flag, and a store that HOLDS the program
//      must not be told to acquire it (mock RPC: no network, deterministic);
//      the opposite world (empty store) must still get the pull advice —
//      one code path, two opposite answers, decided by the store
//   T2 library: probeGap({ storeDir }) reports the held receipt and verdict
//      `stored`, keeping the chain verdict as `chainVerdict`
//   T3 library: a store that does not exist is an ANSWER ('no-store'), never a
//      failure, and never changes the chain verdict
//   T4 library: the store exists but does not hold the program -> 'not-held',
//      chain verdict unchanged (nothing to preserve when nothing changed)
//   T5 library: an RPC failure stays `unknown` + no-verdict even when the
//      store holds the program — the crates.io-403 rule outranks local
//      knowledge — but the store fact and offline decode advice survive
//   T6 library: a store the reader REFUSES (tampered object) rejects BEFORE the
//      probe runs — damage is never reported as 'not-held', and no RPC is spent
//   T7 CLI: the gap output carries no payload count the CLI never measured
//   T8 library: a `stored` row gets acquisition-free advice; the adopted
//      Lighthouse row is never told to adopt-lighthouse again, while a chain
//      that publishes IS still told to pull beside the adopted copy
//   G1 GREEN ON BOTH TREES: the fixture receipts this ladder leans on are
//      exactly what the claims say (non-vacuity — a drifted fixture must not
//      let the store assertions pass against nothing)
//   G2 GREEN ON BOTH TREES: sememe/gap still exposes probeGap + nextStep
//
// The research harness (tools/acquisition-gap.mjs) passes NO storeDir: sweep
// artifacts measure THE CHAIN, never a local store — a private store must not
// be able to move a published artifact.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm, cp } from 'node:fs/promises';
import { promisify } from 'node:util';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CLI = path.join(ROOT, 'bin', 'sememe.mjs');
const FIXTURE_STORE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-store-2026-11-04-pulled');

const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const DCA = 'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M';
// Measured 2026-11-04, committed in the fixture store's receipt filename.
const WHIRL_SLOT = 465104921;
const WHIRL_FINGERPRINT = 'sha256:0b886e375b112206a846a061f076f7db02a4b01b25cd593cd03caa490d86660f';
const LIGHTHOUSE_ORIGIN = 'Jac0xb-lighthouse-4c579479c986';

/** Run the CLI; returns { code, stdout, stderr } instead of throwing. */
function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}

/** Same on-disk shape src/acquire.mjs decodes: Anchor header + deflate body. */
function fakeAnchorAccount(program, idl) {
  const body = zlib.deflateSync(Buffer.from(JSON.stringify(idl)));
  const header = Buffer.alloc(44);
  Buffer.from([24, 70, 98, 191, 58, 144, 123, 158]).copy(header);
  header.writeUInt32LE(body.length, 40);
  return { owner: program, data: [Buffer.concat([header, body]).toString('base64'), 'base64'] };
}

const PULLABLE_IDL = { instructions: [{ name: 'swap', discriminator: [1, 2, 3, 4, 5, 6, 7, 8], args: [] }] };

/**
 * A local getMultipleAccounts server: the CLI half of this ladder must not
 * depend on mainnet's mood (429/timeout), so the chain side is fully
 * deterministic and only the STORE half is under test.
 *
 *   pullable(program)  the probed program publishes an interface at its
 *                      legacy anchor:idl address (owner must match!)
 *   nothing()          neither address answers
 */
function mockRpc(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const request = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { context: { slot: 470046561 }, value: handler(request.params[0]) },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}
const pullable = (program) => mockRpc(() => [null, fakeAnchorAccount(program, PULLABLE_IDL)]);
const nothing = () => mockRpc(() => [null, null]);

/** A fetcher for probeGap() that answers getMultipleAccounts without a server. */
const fetcherOf = (value) => async () => ({
  ok: true,
  json: async () => ({ result: { context: { slot: 470046561 }, value } }),
});
const failingFetcher = async () => { throw new Error('HTTP 403 rate limited'); };

test('T1: the CLI takes --store, and a store that HOLDS the program must not tell a stranger to acquire it', async () => {
  // Whirlpool: the chain publishes an interface (pullable) AND the fixture
  // store already holds the receipt — the exact stranger-reported defect:
  // next said "sememe pull whirLb..." for a program that is already pulled.
  const held1 = await pullable(WHIRLPOOL);
  try {
    const held = await cli(['gap', WHIRLPOOL, '--store', FIXTURE_STORE, '--rpc', held1.url]);
    assert.equal(held.code, 0, `gap must answer, got: ${held.stderr.slice(0, 300)}`);
    const row = JSON.parse(held.stdout);
    assert.equal(row.verdict, 'stored',
      'the store holds a verified receipt, so there is no acquisition gap to report');
    assert.equal(row.chainVerdict, 'pullable', 'the chain fact must survive as chainVerdict');
    assert.equal(row.store.state, 'held');
    assert.equal(row.store.onChain, 1);
    assert.equal(row.store.receipts[0].slot, WHIRL_SLOT, 'the stored slot must be reported');
    assert.equal(row.store.receipts[0].fingerprint, WHIRL_FINGERPRINT, 'the stored fingerprint must be reported');
    assert.doesNotMatch(row.next, /sememe pull/,
      'a program the store already holds must never be told to pull it again');
    assert.match(row.next, /decode/, 'the actionable step for a held program is decode');
  } finally {
    held1.server.close();
  }

  // The opposite world must still get the pull advice — same code path, the
  // store is what decides.
  const held2 = await pullable(DCA);
  try {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'sememe-gap-empty-'));
    try {
      const notHeld = await cli(['gap', DCA, '--store', empty, '--rpc', held2.url]);
      assert.equal(notHeld.code, 0, notHeld.stderr.slice(0, 300));
      const plain = JSON.parse(notHeld.stdout);
      assert.equal(plain.verdict, 'pullable', 'a store without the program must not change the chain verdict');
      assert.equal(plain.store.state, 'no-store', 'the missing receipts dir must be reported as no-store');
      assert.match(plain.next, /sememe pull/,
        'the pull advice must survive when the store does NOT hold the program');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  } finally {
    held2.server.close();
  }
});

test('T2: probeGap({ storeDir }) reports the held receipt and verdict stored, chain verdict preserved', async () => {
  const { probeGap } = await import('../src/gap.mjs');
  const { rows, summary } = await probeGap([{ program: WHIRLPOOL }], {
    url: 'https://mock.invalid/rpc',
    fetcher: fetcherOf([null, fakeAnchorAccount(WHIRLPOOL, PULLABLE_IDL)]),
    storeDir: FIXTURE_STORE,
  });
  const row = rows[0];
  assert.equal(row.store.state, 'held');
  assert.equal(row.store.onChain, 1);
  assert.equal(row.store.adopted, 0);
  assert.equal(row.store.receipts[0].source, 'metadata');
  assert.equal(row.store.receipts[0].slot, WHIRL_SLOT);
  assert.equal(row.store.receipts[0].fingerprint, WHIRL_FINGERPRINT);
  assert.equal(row.verdict, 'stored', 'a verified receipt in the store closes the acquisition question');
  assert.equal(row.chainVerdict, 'pullable', 'the chain-side verdict must remain quotable');
  assert.equal(summary.byVerdict.stored, 1, 'summary must count the stored verdict');
  assert.equal(summary.storedPrograms, 1, 'summary must expose the stored count like the other verdicts');
});

test('T3: a store that does not exist is an ANSWER (no-store), never a failure, and never changes the chain verdict', async () => {
  const { probeGap, storeState } = await import('../src/gap.mjs');
  const missing = path.join(os.tmpdir(), `sememe-gap-no-store-${process.pid}-${Date.now()}`);
  const state = await storeState(missing, WHIRLPOOL);
  assert.equal(state.state, 'no-store', 'a missing store dir must read as no-store, not as an error');
  assert.equal(state.dir, missing);

  const { rows } = await probeGap([{ program: DCA }], {
    url: 'https://mock.invalid/rpc', fetcher: failingFetcher, storeDir: missing,
  });
  assert.equal(rows[0].store.state, 'no-store');
  assert.equal(rows[0].verdict, 'unknown', 'the RPC failure must still be unknown');
});

test('T4: the store exists but does not hold the program -> not-held, chain verdict unchanged', async () => {
  const { probeGap, storeState } = await import('../src/gap.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-gap-not-held-'));
  try {
    await mkdir(path.join(dir, 'receipts'), { recursive: true });
    const state = await storeState(dir, WHIRLPOOL);
    assert.equal(state.state, 'not-held');
    const { rows } = await probeGap([{ program: WHIRLPOOL }], {
      url: 'https://mock.invalid/rpc',
      fetcher: fetcherOf([null, fakeAnchorAccount(WHIRLPOOL, PULLABLE_IDL)]),
      storeDir: dir,
    });
    assert.equal(rows[0].store.state, 'not-held');
    assert.equal(rows[0].verdict, 'pullable', 'an empty side of the store must not move the chain verdict');
    assert.equal(rows[0].chainVerdict, undefined, 'nothing to preserve when the verdict did not change');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('T5: an RPC failure stays unknown + no-verdict EVEN when the store holds the program', async () => {
  const { probeGap, summarize, nextStep } = await import('../src/gap.mjs');
  const { rows, summary } = await probeGap([{ program: WHIRLPOOL }], {
    url: 'https://mock.invalid/rpc', fetcher: failingFetcher, storeDir: FIXTURE_STORE,
  });
  assert.equal(rows[0].store.state, 'held', 'the local knowledge must still be reported');
  assert.equal(rows[0].verdict, 'unknown',
    'the crates.io-403 rule outranks local knowledge: a failed probe claims nothing about the chain');
  assert.equal(rows[0].chainVerdict, undefined);
  assert.equal(summary.verdict, 'no-verdict');
  assert.equal(summarize([{ program: 'x', verdict: 'unknown', store: { state: 'held' } }]).verdict, 'no-verdict');
  // The failed chain half must not hide the offline half from the advice.
  const advice = nextStep(rows[0], WHIRLPOOL);
  assert.match(advice, /RPC did not answer/, 'the refusal must stay the headline of the advice');
  assert.match(advice, /decode/, 'but the held store must still be named as usable offline');
});

test('T6: a store the reader REFUSES rejects before the probe — damage is never reported as not-held', async () => {
  const { probeGap } = await import('../src/gap.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-gap-damaged-'));
  try {
    await cp(FIXTURE_STORE, dir, { recursive: true });
    const objectPath = path.join(dir, 'objects', `${WHIRL_FINGERPRINT.slice('sha256:'.length)}.json`);
    const tampered = JSON.parse(await readFile(objectPath, 'utf8'));
    tampered.instructions[0].name = 'renamed_by_hand';
    await writeFile(objectPath, JSON.stringify(tampered));
    let probed = false;
    const fetcher = async () => { probed = true; throw new Error('must not be reached'); };
    await assert.rejects(
      () => probeGap([{ program: WHIRLPOOL }], { url: 'https://mock.invalid/rpc', fetcher, storeDir: dir }),
      /refusing to decode/,
      'a tampered stored object must be refused BY NAME',
    );
    assert.equal(probed, false, 'the refusal must happen BEFORE any RPC is spent');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('T7: the gap output carries no payload count the CLI never measured', async () => {
  // Pre-fix the CLI printed `payloads: 0` — a measured-looking number no probe
  // had produced (the sweep's counts live in the research report, not here).
  const server = await nothing();
  try {
    const withStore = await cli(['gap', LIGHTHOUSE, '--store', FIXTURE_STORE, '--rpc', server.url]);
    assert.equal(withStore.code, 0, withStore.stderr.slice(0, 300));
    assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(withStore.stdout), 'payloads'), false,
      'the CLI must not print a payload count it did not measure');
    const bare = await cli(['gap', LIGHTHOUSE, '--rpc', server.url]);
    assert.equal(bare.code, 0, bare.stderr.slice(0, 300));
    assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(bare.stdout), 'payloads'), false);
  } finally {
    server.server.close();
  }
});

test('T8: a stored row gets acquisition-free advice; adopted Lighthouse is never told to adopt it again', async () => {
  const { nextStep } = await import('../src/gap.mjs');

  // Store holds the on-chain pull: decode, never pull.
  const storedPulled = {
    program: WHIRLPOOL, verdict: 'stored', chainVerdict: 'pullable',
    store: { state: 'held', dir: FIXTURE_STORE, onChain: 1, adopted: 0, receipts: [
      { source: 'metadata', slot: WHIRL_SLOT, fingerprint: WHIRL_FINGERPRINT, origin: null,
        label: `metadata @slot ${WHIRL_SLOT}` },
    ] },
  };
  const advice = nextStep(storedPulled, WHIRLPOOL);
  assert.doesNotMatch(advice, /sememe pull/, 'nothing is missing, so no pull advice');
  assert.match(advice, /decode/, 'the actionable step for a held program is decode');
  assert.match(advice, new RegExp(String(WHIRL_SLOT)), 'the advice must name the slot the copy came from');

  // Store holds only the adopted copy, chain publishes nothing: decode, never adopt-lighthouse.
  const storedAdopted = {
    program: LIGHTHOUSE, verdict: 'stored', chainVerdict: 'no-interface-published',
    store: { state: 'held', dir: FIXTURE_STORE, onChain: 0, adopted: 1, receipts: [
      { source: 'first-party', slot: null, fingerprint: `sha256:${'461e28fd1c7e33f3'.repeat(4)}`,
        origin: LIGHTHOUSE_ORIGIN, label: 'first-party (adopted, declared origin: Jac0xb-lighthouse-4c579479c986)' },
    ] },
  };
  const adoptedAdvice = nextStep(storedAdopted, LIGHTHOUSE);
  assert.doesNotMatch(adoptedAdvice, /adopt-lighthouse/,
    'the adopted copy it already holds must not be adopted a second time');
  assert.doesNotMatch(adoptedAdvice, /sememe pull/, 'the chain publishes nothing here: a pull can never succeed');
  assert.match(adoptedAdvice, /decode/, 'the actionable step for an adopted copy is decode');
  assert.match(adoptedAdvice, new RegExp(LIGHTHOUSE_ORIGIN), 'the advice must name the declared origin it holds');

  // Store holds only the adopted copy, chain publishes an on-chain interface:
  // the on-chain receipt is genuinely missing, so the pull advice MUST survive.
  const adoptedOnlyChainPullable = {
    program: DCA, verdict: 'stored', chainVerdict: 'pullable',
    store: { state: 'held', dir: FIXTURE_STORE, onChain: 0, adopted: 1, receipts: [
      { source: 'published', slot: null, fingerprint: 'sha256:e4ace752', origin: 'jup_dca.json',
        label: 'published (adopted, declared origin: jup_dca.json)' },
    ] },
  };
  assert.match(nextStep(adoptedOnlyChainPullable, DCA), /sememe pull/,
    'with only an adopted copy and an interface on chain, adding the on-chain receipt IS the step');
});

test('G1: the fixture receipts this ladder leans on are exactly what the claims say (false-positive guard)', async () => {
  const { findStoredIdls } = await import('../src/store-read.mjs');
  const whirl = await findStoredIdls(FIXTURE_STORE, WHIRLPOOL);
  assert.equal(whirl.onChain.length, 1, 'the fixture store must hold exactly one on-chain Whirlpool receipt');
  assert.equal(whirl.onChain[0].idlMeta.slot, WHIRL_SLOT);
  assert.equal(whirl.onChain[0].idlMeta.fingerprint, WHIRL_FINGERPRINT);
  assert.equal(whirl.adopted.length, 0);

  const lighthouse = await findStoredIdls(FIXTURE_STORE, LIGHTHOUSE);
  assert.equal(lighthouse.onChain.length, 0, 'Lighthouse is adopted-only in the fixture store');
  assert.equal(lighthouse.adopted.length, 1);
  assert.equal(lighthouse.adopted[0].idlMeta.origin, LIGHTHOUSE_ORIGIN);
  assert.equal(lighthouse.adopted[0].idlMeta.slot, null);
});

test('G2: sememe/gap still exposes probeGap and nextStep', async () => {
  const gap = await import('../src/gap.mjs');
  assert.equal(typeof gap.probeGap, 'function');
  assert.equal(typeof gap.nextStep, 'function');
});
