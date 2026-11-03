import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The Raydium AMM v4 table is DERIVED from the vendored upstream program
 * source (`src/raydium-interface.mjs`), committed as a reviewable artifact
 * (`interface/raydium-<program>.json`), and re-derived AT LOAD: the module
 * refuses to decode unless the committed artifact equals a fresh derivation of
 * the vendored bytes.
 *
 * These tests pin that contract by mutation, not by assertion:
 *
 *   1. The committed artifact is exactly today's derivation (a stale artifact
 *      fails the CLI check, so nobody approves a table nobody regenerated).
 *   2. A tampered ARTIFACT refuses the load — decoding comes from the
 *      derivation, never from the artifact's own bytes.
 *   3. A tampered VENDORED SOURCE refuses the load (the hash the artifact
 *      claims), for BOTH files this table reads.
 *   4. A MISSING vendored source refuses the load.
 *   5. The wire is upstream's own: every tag in the table equals the tag the
 *      pack() arm writes, the seven variants upstream refuses stay refused,
 *      and the optional group is a LENGTH GUARD rather than an option tag.
 *   6. The measured mainnet payloads decode, name themselves, and re-encode
 *      byte-exactly — so a field-order or width error cannot pass.
 *
 * Falsification of the tests themselves: removing the load-time equality check
 * turns 2 and 3 into silent passes; the runtime would then decode from
 * whichever copy won.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const SAMPLE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-2026-11-02.json');

/** A throwaway copy of everything `src/raydium.mjs` reads at load time. */
function copyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-raydium-'));
  for (const part of ['src', 'interface', 'vendor']) {
    fs.cpSync(path.join(ROOT, part), path.join(dir, part), { recursive: true });
  }
  return dir;
}

/** Import `src/raydium.mjs` from a copy; the load-time check runs on import. */
function loadFrom(dir) {
  const target = `${pathToFileURL(path.join(dir, 'src', 'raydium.mjs')).href}?t=${Date.now()}-${Math.random()}`;
  return import(target);
}

const VENDOR = path.join('vendor', 'raydium-amm',
  '91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6', 'program', 'src');

test('the committed Raydium artifact is exactly what the derivation produces', () => {
  const out = execFileSync(process.execPath, ['tools/raydium-interface.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 1, 'one pinned Raydium program');
  assert.match(lines[0], /: current \(19 variants, sha256:[0-9a-f]{8}\+[0-9a-f]{8}\)/);
});

test('a tampered ARTIFACT refuses the load (decode comes from the derivation)', async () => {
  const dir = copyRepo();
  try {
    const file = path.join(dir, 'interface', `raydium-${RAYDIUM_AMM_V4}.json`);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const swap = doc.instructions.find((ix) => ix.name === 'SwapBaseIn');
    assert.ok(swap, 'SwapBaseIn must be in the table');
    // Swap amount_in and minimum_amount_out: the wire would be read backwards.
    swap.args.reverse();
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    await assert.rejects(loadFrom(dir), /refuses to load/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tampered vendored INSTRUCTION source refuses the load (the claimed hash)', async () => {
  const dir = copyRepo();
  try {
    const file = path.join(dir, VENDOR, 'instruction.rs');
    fs.appendFileSync(file, '\n// tampered: an extra byte write in a pack arm\n');
    await assert.rejects(loadFrom(dir), /does not equal a fresh derivation/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tampered vendored STATE source refuses the load (AmmParams/Fees live there)', async () => {
  const dir = copyRepo();
  try {
    const file = path.join(dir, VENDOR, 'state.rs');
    // AmmParams::Fees is branch value 2; changing it changes what tag 6 means.
    fs.appendFileSync(file, '\n// tampered: an extra byte write in Fees::pack_into_slice\n');
    await assert.rejects(loadFrom(dir), /does not equal a fresh derivation/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a MISSING vendored source refuses the load', async () => {
  const dir = copyRepo();
  try {
    fs.rmSync(path.join(dir, 'vendor', 'raydium-amm'), { recursive: true, force: true });
    await assert.rejects(loadFrom(dir), /not found|ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every tag is the one upstream pack() writes, cross-checked against unpack()', async () => {
  const { deriveAllRaydiumInterfaces } = await import(path.join(ROOT, 'src', 'raydium-interface.mjs'));
  const [doc] = deriveAllRaydiumInterfaces();
  const byName = new Map(doc.instructions.map((ix) => [ix.name, ix]));

  // Every tag in the table, and why the refused ones can be named at all.
  //
  // In upstream's `AmmInstruction` the declaration index equals the wire tag
  // for every variant — that is a MEASURED property of this file (checked in
  // src/raydium-interface.mjs for every reachable variant), not an assumption:
  // the reachable tags were proven twice, from pack()'s literal push and from
  // unpack()'s binding, and both agree with the position. That is what lets
  // the seven REFUSED variants — which have no pack() arm to read a tag from —
  // be named by their position. If upstream ever reorders the enum, the
  // reachable check fails and the derivation stops instead of mislabeling them.
  assert.equal(doc.selector.width, 1, 'the selector is one byte');
  assert.equal(byName.get('SwapBaseIn').tag, 9);
  assert.equal(byName.get('SwapBaseInV2').tag, 16);
  assert.equal(byName.get('UpdateConfigAccount').tag, 15);
  assert.equal(byName.get('WithdrawExcessLamports').tag, 18);
  assert.equal(byName.get('Initialize2').tag, 1);

  // Upstream declares 19 variants; 12 are reachable and 7 are refused with
  // unimplemented!(). Naming one of those would disagree with the chain.
  assert.equal(doc.instructions.length, 19);
  const refused = doc.instructions.filter((ix) => ix.wire === 'rejected');
  assert.deepEqual(refused.map((ix) => ix.tag), [0, 2, 5, 8, 10, 12, 13],
    'the seven tags upstream panics on, in tag order');
  const reachable = doc.instructions.filter((ix) => ix.wire === 'accepted');
  assert.equal(reachable.length, 12);
});

test('the optional group is upstream\'s length guard, not an option tag', async () => {
  const { deriveAllRaydiumInterfaces } = await import(path.join(ROOT, 'src', 'raydium-interface.mjs'));
  const [doc] = deriveAllRaydiumInterfaces();
  const byName = new Map(doc.instructions.map((ix) => [ix.name, ix]));

  // Deposit: other_amount_min is present iff at least 8 bytes remain; there is
  // NO 0/1 option byte anywhere upstream. A C-style read would misparse every
  // one of the 9 measured payloads (they carry no option byte either).
  const deposit = byName.get('Deposit');
  assert.equal(deposit.optional.presentWhenRemainingAtLeast, 8);
  assert.deepEqual(deposit.optional.args.map((a) => a.name), ['other_amount_min']);

  // Withdraw: both min amounts come as a group of 16, or not at all.
  const withdraw = byName.get('Withdraw');
  assert.equal(withdraw.optional.presentWhenRemainingAtLeast, 16);
  assert.deepEqual(withdraw.optional.args.map((a) => a.name), ['min_coin_amount', 'min_pc_amount']);

  // SetParams branches on `param`; value 2 carries the packed 64-byte Fees
  // struct, values 0/1/3 carry one u64.
  const setParams = byName.get('SetParams');
  const feesBranch = setParams.branches.find((b) => b.values.includes(2));
  const valueBranch = setParams.branches.find((b) => b.values.includes(0));
  assert.equal(feesBranch.args[0].type, 'amm_fees');
  assert.equal(doc.ammFees.len, 64, 'Fees::LEN is 64');
  assert.equal(doc.ammFees.fields.length, 8, 'eight u64 fee fields');
  assert.deepEqual(valueBranch.args.map((a) => a.name), ['value']);
  assert.deepEqual([...valueBranch.values].sort((a, b) => a - b), [0, 1, 3],
    'AmmParams: Status=0, State=1, SetOpenTime=3 — and Fees=2 takes the other branch');
});

test('the 9 measured mainnet payloads decode, name themselves, and re-encode byte-exactly', async () => {
  const { decodeRaydiumInstruction } = await import(path.join(ROOT, 'src', 'raydium.mjs'));
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  const payloads = sample.transactions.flatMap((tx) => (tx.payloads ?? [])
    .filter((p) => p.program === RAYDIUM_AMM_V4)
    .map((p) => ({ hex: p.dataHex, txErr: tx.txErr ?? null })));

  assert.equal(payloads.length, 9, 'Raydium AMM v4 carried exactly 9 payloads in the sample');
  const names = new Map();
  for (const row of payloads) {
    const bytes = Buffer.from(row.hex, 'hex');
    const decoded = decodeRaydiumInstruction(RAYDIUM_AMM_V4, bytes);
    assert.equal(decoded.roundTripByteExact, true, `${row.hex} must re-encode byte-exactly`);
    assert.equal(decoded.trailing.count, 0, `${row.hex} is fully described — no unexplained bytes`);
    assert.equal(decoded.absent.length, 0, `${row.hex} carries every field its wire form has`);
    names.set(decoded.name, (names.get(decoded.name) ?? 0) + 1);
    // The amounts are the chain's own numbers: swapping the two u64s of a
    // swap would produce a different re-encode and a different value here.
    assert.ok(BigInt(decoded.args.amount_in) > 0n, `${row.hex}: amount_in must be a real amount`);
  }
  // Both swap variants appear on this wire; only the pinned table names both.
  assert.deepEqual([...names.keys()].sort(), ['SwapBaseIn', 'SwapBaseInV2']);
  assert.equal(names.get('SwapBaseIn'), 2);
  assert.equal(names.get('SwapBaseInV2'), 7);
});

test('refusals are named, not guessed: unknown tag, refused variant, truncated bytes', async () => {
  const { decodeRaydiumInstruction, raydiumRefusal, isRaydiumProgram, raydiumPrograms } =
    await import(path.join(ROOT, 'src', 'raydium.mjs'));

  assert.equal(isRaydiumProgram(RAYDIUM_AMM_V4), true);
  assert.deepEqual(raydiumPrograms(), [RAYDIUM_AMM_V4]);
  assert.equal(isRaydiumProgram('11111111111111111111111111111111'), false);

  // The tri-state: not our program is NOT a refusal of the bytes.
  assert.deepEqual(decodeRaydiumInstruction('11111111111111111111111111111111', Buffer.from([9])),
    { refused: 'not-raydium' });
  assert.equal(raydiumRefusal('11111111111111111111111111111111', Buffer.from([9])), 'not-raydium');

  const cases = [
    [Buffer.from([99, 1, 2]), 'unknown-selector', /tag 99/],
    // Initialize, MigrateToOpenBook, WithdrawSrm: upstream panics on these.
    [Buffer.from([0]), 'wire-rejected', /Initialize \(tag 0\)/],
    [Buffer.from([5]), 'wire-rejected', /MigrateToOpenBook \(tag 5\)/],
    [Buffer.from([8]), 'wire-rejected', /WithdrawSrm \(tag 8\)/],
    // Truncated: a short payload must never be named as a shorter instruction.
    [Buffer.from([9, 1, 2, 3]), 'truncated', /truncated u64/],
    [Buffer.from([1, 7, 0, 0]), 'truncated', /truncated u64/],
    [Buffer.from([15, 1, 1, 2, 3]), 'truncated', /truncated pubkey/],
    [Buffer.from([6, 2, 1, 2, 3]), 'truncated', /truncated fees struct/],
    // SetParams discriminator no AmmParams variant carries.
    [Buffer.from([6, 9, ...Array(8).fill(0)]), 'unknown-branch', /discriminator 9/],
    // UpdateConfigAccount's wildcard: upstream returns InvalidInstructionData.
    [Buffer.from([15, 9, ...Array(8).fill(0)]), 'wire-rejected', /param=9/],
    [Buffer.alloc(0), 'empty-payload', /no instruction data/],
  ];
  for (const [bytes, reason, pattern] of cases) {
    assert.equal(raydiumRefusal(RAYDIUM_AMM_V4, bytes), reason,
      `${bytes.toString('hex') || '<empty>'} must refuse as ${reason}`);
    assert.throws(() => decodeRaydiumInstruction(RAYDIUM_AMM_V4, bytes),
      (error) => error.reason === reason && pattern.test(error.message),
      `${bytes.toString('hex') || '<empty>'}: ${reason}`);
  }
});

test('trailing bytes are reported, never absorbed into the decode', async () => {
  const { decodeRaydiumInstruction } = await import(path.join(ROOT, 'src', 'raydium.mjs'));

  // WithdrawPnl has no args; upstream ignores anything after the tag, and the
  // table reports those bytes instead of pretending they are part of it.
  const decoded = decodeRaydiumInstruction(RAYDIUM_AMM_V4, Buffer.from([7, 1, 2, 3]));
  assert.equal(decoded.name, 'WithdrawPnl');
  assert.equal(decoded.consumed, 1);
  assert.equal(decoded.trailing.count, 3);
  assert.equal(decoded.roundTripByteExact, false, 'a payload with unexplained bytes is not byte-exact');
  assert.throws(() => decodeRaydiumInstruction(RAYDIUM_AMM_V4, Buffer.from([7, 1, 2, 3]),
    { trailing: 'error' }), (error) => error.reason === 'trailing-bytes');

  // 4 bytes after Deposit's 24 are SHORT of the optional group's own guard
  // (8), so upstream reads them as absent and this table reports them —
  // it does NOT invent a partial option.
  const deposit = decodeRaydiumInstruction(RAYDIUM_AMM_V4,
    Buffer.concat([Buffer.from([3]), Buffer.alloc(24), Buffer.alloc(4, 9)]));
  assert.deepEqual(deposit.absent, ['other_amount_min']);
  assert.equal(deposit.trailing.count, 4);
  assert.equal(deposit.roundTripByteExact, false);
});

test('the optional group round-trips in both directions', async () => {
  const { decodeRaydiumInstruction, encodeRaydiumInstruction } = await import(path.join(ROOT, 'src', 'raydium.mjs'));
  const hex = (s) => Buffer.from(s, 'hex');

  // A short Withdraw (no min amounts) re-encodes short; a full one re-encodes
  // full. There is no third encoding, because there is no option byte.
  const short = decodeRaydiumInstruction(RAYDIUM_AMM_V4, hex('040500000000000000'));
  assert.deepEqual(short.absent, ['min_coin_amount', 'min_pc_amount']);
  assert.equal(short.roundTripByteExact, true);

  const fullHex = '04050000000000000009000000000000000a00000000000000';
  const full = decodeRaydiumInstruction(RAYDIUM_AMM_V4, hex(fullHex));
  assert.equal(full.absent.length, 0);
  assert.equal(full.roundTripByteExact, true);
  assert.equal(encodeRaydiumInstruction(RAYDIUM_AMM_V4, 'Withdraw', full.args).toString('hex'), fullHex);

  // Supplying only half the group is refused, not guessed.
  assert.throws(() => encodeRaydiumInstruction(RAYDIUM_AMM_V4, 'Withdraw',
    { amount: 5n, min_coin_amount: 9n }), (error) => error.reason === 'partial-optional');
  // A missing required arg is refused too.
  assert.throws(() => encodeRaydiumInstruction(RAYDIUM_AMM_V4, 'Initialize2', { nonce: 1 }),
    (error) => error.reason === 'missing-arg');
  // A refused variant cannot be encoded, so no caller can mint its bytes.
  assert.throws(() => encodeRaydiumInstruction(RAYDIUM_AMM_V4, 'Initialize', {}),
    (error) => error.reason === 'wire-rejected');
  assert.throws(() => encodeRaydiumInstruction(RAYDIUM_AMM_V4, 'NoSuchInstruction', {}),
    (error) => error.reason === 'unknown-variant');
});

test('the provenance names the pin, both files and the reachable/refused split', async () => {
  const { raydiumProvenance } = await import(path.join(ROOT, 'src', 'raydium.mjs'));
  const provenance = raydiumProvenance(RAYDIUM_AMM_V4);
  assert.equal(provenance.label, 'Raydium AMM v4');
  assert.match(provenance.interface, /raydium-io\/raydium-amm@91739d8d/);
  assert.match(provenance.interface, /instruction\.rs/);
  assert.match(provenance.interface, /state\.rs/);
  assert.equal(provenance.variants, 19, '19 declared variants');
  assert.equal(provenance.reachable, 12, '12 are reachable on the wire');
  assert.equal(provenance.refused, 7, '7 are refused by upstream itself');
  assert.equal(provenance.scheme, 'legacy-rust');
  assert.equal(raydiumProvenance('11111111111111111111111111111111'), null);
});
