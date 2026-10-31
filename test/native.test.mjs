import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeNativeInstruction, encodeNativeInstruction, nativeNames, nativeProvenance,
  nativePrograms, isNativeProgram, isNativeName, nativeRefusal,
} from '../src/native.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

const SYSTEM = '11111111111111111111111111111111';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

/**
 * The two native programs have no IDL account to pull, so their interface comes
 * from the pinned upstream runtime. These tests pin FOUR things:
 *
 *   1. What the pinned interface says (names, order, provenance).
 *   2. That real mainnet payloads decode and re-encode byte for byte.
 *   3. That the byte shapes that the first consumer's hand-written table got
 *      WRONG are the ones this table gets right — the u64 string header, the
 *      two System variants the hand table never heard of, and the wire-rejected
 *      ComputeBudget tag 0.
 *   4. That the refusals are refusals: an unknown tag, a truncated payload and
 *      trailing bytes each get a NAMED reason instead of a confident label.
 *
 * The false-positive guard is explicit: `Transfer` on the System program must
 * keep decoding — that is the one case that was already correct and must not
 * regress while the table grows.
 */

function loadHarvest(file) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
}

function payloadsOf(harvest) {
  const payloads = [];
  for (const transaction of harvest.transactions ?? []) {
    for (const payload of transaction.payloads ?? []) payloads.push(payload);
  }
  return payloads;
}

test('the pinned interface covers every native program and variant', () => {
  assert.deepEqual(nativePrograms().sort(), [COMPUTE_BUDGET, SYSTEM].sort());

  // System: 14 variants in the pinned enum (0..13), all claimable — System has
  // no reserved slot (Unused is ComputeBudget's variant 0).
  // `UpgradeNonceAccount` and `CreateAccountAllowPrefund` are the two the
  // hand-written table could not name — they are named here.
  const systemNames = nativeNames(SYSTEM);
  assert.equal(systemNames.length, 14, '14 claimable System variants (0..13)');
  assert.ok(systemNames.includes('UpgradeNonceAccount'), 'variant 12 must be nameable');
  assert.ok(systemNames.includes('CreateAccountAllowPrefund'), 'variant 13 must be nameable');
  assert.ok(!systemNames.includes('Unused'), 'the reserved variant is not a claimable name');

  // ComputeBudget: 4 claimable variants (1..4).
  assert.deepEqual(nativeNames(COMPUTE_BUDGET).sort(),
    ['RequestHeapFrame', 'SetComputeUnitLimit', 'SetComputeUnitPrice', 'SetLoadedAccountsDataSizeLimit'].sort());

  const provenance = nativeProvenance(SYSTEM);
  assert.match(provenance.interface, /solana-sdk@[0-9a-f]{40}/, 'the interface pin is a commit hash');
  assert.match(provenance.runtime, /agave/, 'the runtime rule is named');
  assert.ok(provenance.measured.includes('63/63'), 'the measured string-header claim is recorded');
});

test('every real System payload decodes and re-encodes byte for byte', () => {
  const harvest = loadHarvest('harvest-system-2026-10-31.json');
  const payloads = payloadsOf(harvest);
  assert.ok(payloads.length > 1000, `expected the real traffic, found ${payloads.length} payload(s)`);

  const byName = {};
  let roundTripExact = 0;
  for (const payload of payloads) {
    const bytes = Buffer.from(payload.dataHex, 'hex');
    const decoded = decodeNativeInstruction(SYSTEM, bytes);
    byName[decoded.name] = (byName[decoded.name] ?? 0) + 1;
    assert.equal(decoded.trailing.count, 0, `${decoded.name} must explain every byte`);
    if (decoded.roundTripByteExact) roundTripExact += 1;
  }
  assert.equal(roundTripExact, payloads.length,
    'every decoded System payload must re-encode to the exact chain bytes');

  // The measured distribution, pinned so a table change cannot silently
  // re-label traffic.
  assert.equal(byName.Transfer, 1026);
  assert.equal(byName.CreateAccount, 643);
  assert.equal(byName.AdvanceNonceAccount, 67);
  assert.equal(byName.CreateAccountWithSeed, 63);
  assert.equal(byName.Assign, 14);
  assert.equal(byName.Allocate, 14);
  assert.equal(byName.InitializeNonceAccount, 1);
});

test('the string-header case the hand-written table got wrong is now right', () => {
  // The hand table read a 4-byte string header; the chain carries a u64
  // (bincode fixint) length word. On the real traffic the hand table could
  // name 0 of these 63 payloads. Here every one is named AND re-encoded.
  const harvest = loadHarvest('harvest-system-2026-10-31.json');
  const seeded = payloadsOf(harvest).filter((payload) => payload.dataHex.startsWith('03000000'));
  assert.equal(seeded.length, 63, 'the measured CreateAccountWithSeed count');

  for (const payload of seeded) {
    const bytes = Buffer.from(payload.dataHex, 'hex');
    const decoded = decodeNativeInstruction(SYSTEM, bytes);
    assert.equal(decoded.name, 'CreateAccountWithSeed');
    assert.ok(decoded.roundTripByteExact, 'a seeded payload must re-encode exactly');
    // The seed is readable text, not shifted bytes — the defect the hand table
    // produced was a 4-byte shift that turned every seed into binary noise.
    assert.match(decoded.args.seed, /^[!-~]+$/, 'the seed decodes to printable ASCII');
    assert.ok(decoded.args.seed.length <= 32, 'the seed fits the documented 32-byte limit');
    assert.match(decoded.args.owner, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'the owner is a valid base58 pubkey');
    assert.ok(BigInt(decoded.args.lamports) > 0n, 'each real seeded account carries lamports');
  }
});

test('every real ComputeBudget payload decodes, and the wire-rejected tag 0 stays rejected', () => {
  const harvest = loadHarvest('harvest-compute-budget-2026-10-31.json');
  const payloads = payloadsOf(harvest);
  assert.ok(payloads.length > 1000, `expected the real traffic, found ${payloads.length} payload(s)`);

  const byName = {};
  let refusals = 0;
  for (const payload of payloads) {
    const bytes = Buffer.from(payload.dataHex, 'hex');
    try {
      const decoded = decodeNativeInstruction(COMPUTE_BUDGET, bytes);
      byName[decoded.name] = (byName[decoded.name] ?? 0) + 1;
    } catch (error) {
      refusals += 1;
      assert.equal(error.reason, 'wire-rejected', 'the only refusal reason must be the wire rule');
    }
  }
  assert.equal(refusals, 0, 'no live mainnet ComputeBudget payload is wire-rejected');
  assert.equal(byName.SetComputeUnitLimit, 651);
  assert.equal(byName.SetComputeUnitPrice, 550);
  assert.equal(byName.SetLoadedAccountsDataSizeLimit, 147);

  // Tag 0 is the reserved variant: the runtime rejects it as
  // InvalidInstructionData, so this decoder must refuse it rather than name
  // it. @solana/web3.js still ENCODES this legacy shape — copying the SDK's
  // opinion here would disagree with the chain.
  assert.throws(
    () => decodeNativeInstruction(COMPUTE_BUDGET, Buffer.from([0x00, 0x40, 0x0d, 0x03, 0x00])),
    (error) => error.reason === 'wire-rejected');
  assert.equal(nativeRefusal(COMPUTE_BUDGET, Buffer.from([0x00, 0x40, 0x0d, 0x03, 0x00])), 'wire-rejected');
});

test('refusals carry a named reason instead of a confident label', () => {
  // Unknown tag.
  assert.equal(nativeRefusal(SYSTEM, Buffer.from([0xff, 0xff, 0xff, 0xff])), 'unknown-selector');
  // Truncated selector.
  assert.equal(nativeRefusal(SYSTEM, Buffer.from([0x01, 0x02])), 'truncated-selector');
  // Truncated body.
  assert.equal(nativeRefusal(SYSTEM, Buffer.from([0x02, 0x00, 0x00, 0x00, 0x01])), 'truncated-u64');
  // Not a native program at all.
  assert.equal(nativeRefusal('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', Buffer.from([0x01])), 'not-native');
});

test('trailing bytes are reported, and refused when the caller asks for strictness', () => {
  // 27 real payloads carry trailing bytes; the runtime tolerates them, so the
  // default reports them instead of dropping them silently.
  const harvest = loadHarvest('harvest-compute-budget-2026-10-31.json');
  const trailing = payloadsOf(harvest)
    .map((payload) => Buffer.from(payload.dataHex, 'hex'))
    .filter((bytes) => {
      try {
        const decoded = decodeNativeInstruction(COMPUTE_BUDGET, bytes);
        return decoded.trailing.count > 0;
      } catch {
        return false;
      }
    });
  assert.equal(trailing.length, 27, 'the measured count of payloads with unexplained trailing bytes');
  assert.equal(trailing[0].length, 12, 'the first measured trailing case');

  for (const bytes of trailing) {
    const reported = decodeNativeInstruction(COMPUTE_BUDGET, bytes);
    assert.ok(reported.trailing.count > 0);
    assert.equal(reported.roundTripByteExact, false, 'trailing bytes are not byte-exact');
    assert.throws(
      () => decodeNativeInstruction(COMPUTE_BUDGET, bytes, { trailing: 'error' }),
      (error) => error.reason === 'trailing-bytes');
  }
});

test('FALSE-POSITIVE GUARD: the case that already worked still works', () => {
  // This is the ONLY case expected to decode correctly before this change:
  // a System Transfer. It must keep decoding, with the right name, the right
  // amount, and an exact re-encode. If this test fails, the table grew a bug
  // while fixing the string header.
  const bytes = Buffer.from('02000000b168de3a00000000', 'hex');
  const decoded = decodeNativeInstruction(SYSTEM, bytes);
  assert.equal(decoded.name, 'Transfer');
  assert.equal(decoded.args.lamports, 987654321n);
  assert.equal(decoded.roundTripByteExact, true);
  assert.equal(decoded.consumed, 12);
  assert.equal(decoded.trailing.count, 0);
  assert.equal(isNativeName(SYSTEM, 'Transfer'), true);
  assert.equal(isNativeProgram(SYSTEM), true);
});

test('a name that does not re-encode is a wrong name: the encoder refuses mismatches', () => {
  // Transfer belongs to System only. Re-encoding it against ComputeBudget
  // must fail rather than produce plausible bytes.
  assert.throws(() => encodeNativeInstruction(COMPUTE_BUDGET, 'Transfer', { lamports: 1n }),
    (error) => error.reason === 'unknown-selector');
  // A missing argument is refused instead of being encoded as zero.
  assert.throws(() => encodeNativeInstruction(SYSTEM, 'Transfer', {}),
    (error) => error.reason === 'missing-arg');
  // An out-of-range value is refused instead of wrapping.
  assert.throws(() => encodeNativeInstruction(SYSTEM, 'Transfer', { lamports: 2n ** 64n }),
    (error) => error.message.includes('out of u64 range'));
});

test('the decode core stays dependency-free: the native module imports only node builtins', async () => {
  const source = fs.readFileSync(path.join(HERE, '..', 'src', 'native.mjs'), 'utf8');
  const bare = [];
  for (const match of source.matchAll(/(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) {
    if (!match[1].startsWith('node:') && !match[1].startsWith('.')) bare.push(match[1]);
  }
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!match[1].startsWith('node:') && !match[1].startsWith('.')) bare.push(match[1]);
  }
  assert.deepEqual(bare, [], `the native decoder must be importable without npm packages: ${bare.join(', ')}`);
});

test('the committed coverage report is the one the tool produces', () => {
  // The report is committed so the measurement can be re-derived; the numbers
  // in it must match a fresh decode of the committed fixture, so a hand-edited
  // report fails.
  const report = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'research', 'native-coverage-system-2026-10-31.json'), 'utf8'));
  const harvest = loadHarvest('harvest-system-2026-10-31.json');
  const payloads = payloadsOf(harvest);
  assert.equal(report.harvest.payloads, payloads.length);

  // Re-derive every number the report claims, from the committed fixture.
  const byName = {};
  let roundTripExact = 0;
  for (const payload of payloads) {
    const decoded = decodeNativeInstruction(SYSTEM, Buffer.from(payload.dataHex, 'hex'));
    byName[decoded.name] = (byName[decoded.name] ?? 0) + 1;
    if (decoded.roundTripByteExact) roundTripExact += 1;
  }
  assert.equal(report.coverage.decoded, payloads.length);
  assert.equal(report.coverage.roundTripByteExact, roundTripExact);
  assert.deepEqual(report.coverage.refusals, {});
  assert.deepEqual(report.coverage.byName, byName,
    'the committed report must equal a fresh decode of the committed fixture');
  assert.equal(report.coverage.byName.CreateAccountWithSeed, 63);
  assert.equal(report.oracle.oldTable.named, payloads.length - 63,
    'the measured old-table miss count: 63 CreateAccountWithSeed');
});
