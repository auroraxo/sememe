// The encoder must reproduce every name the token table CLAIMS.
//
// THE DEFECT THIS FILE PINS (measured 2026-11-15, 15.11. PULS AN).
//
// Token-2022's processor consults its ONE-BYTE token table first and falls
// through to `TokenMetadataInstruction::unpack` when no variant matches.
// src/token.mjs mirrors that order on DECODE (the fallback branch) and
// `tokenNames()` / `isTokenName()` advertise the five metadata names
// (Initialize, UpdateField, RemoveKey, UpdateAuthority, Emit) as names this
// program has — 48 token names + 5 metadata names = 53.
//
// The ENCODER never learned that branch. Measured on the pre-fix tree
// (commit e28c849 == tag v0.4.27 == npm latest):
//
//   tokenNames(TOKEN_2022) contains 'Initialize'        -> true
//   isTokenName(TOKEN_2022, 'Initialize')               -> true
//   encodeTokenInstruction(TOKEN_2022, 'Initialize', …) -> unknown-variant
//
// for ALL FIVE names. So the product could NAME a payload it could not
// reproduce: the decoder named the bytes, the name list advertised them, and
// the encoder refused them as unknown. Every decode round trip stayed green
// anyway, because the fallback decoder computes `roundTripByteExact` with
// its OWN encoder — the token API's encoder was only reachable by a consumer
// who re-encodes from the decoded name (tools/stranger-decode.mjs does exactly
// that as its second byte-check, and any consumer following the documented
// decode -> encode flow hits it directly).
//
// Second face, same wrap site: the fallback error is normalized with
// `new TokenCodecError(error.reason, error.message)` where `error.message`
// ALREADY begins with the reason — so a refusal printed its reason twice
// ("trailing-bytes: trailing-bytes: …", measured on the pre-fix tree). The
// normalizer now strips exactly one leading "<reason>: " when it is present.
//
// Ladder (faces run against BOTH trees; D = defect, red on e28c849):
//   D1 every name tokenNames() advertises is encodable-or-arg-refused,
//      never unknown-variant            (pre-fix: 5 names unknown-variant)
//   D2 the 10 committed mainnet metadata payloads re-encode byte-exactly
//      through the TOKEN API            (pre-fix: 0/10, all unknown-variant)
//   D3 the 4 chain-witnessed oracle payloads re-encode byte-exactly
//      through the TOKEN API            (pre-fix: 0/4)
//   D4 a wrapped fallback refusal names its reason exactly once
//      (pre-fix: "trailing-bytes: trailing-bytes")
//   G1 legacy SPL Token still refuses every metadata name (no fallback leak)
//   G2 a name neither table declares is still unknown-variant
//   G3 the token table itself is untouched: a real TransferChecked payload
//      still round-trips byte-exactly and the name count stays 48 + 5 = 53
//   G4 the decoder's reasons are unchanged (unknown-selector stays
//      unknown-selector; trailing-bytes stays trailing-bytes)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const METADATA_NAMES = ['Initialize', 'UpdateField', 'RemoveKey', 'UpdateAuthority', 'Emit'];

// The 4 chain-witnessed payloads the upstream cross-check recorded
// (research/token-metadata-oracle-2026-11-03.json, slots 464868999 — the
// values are copied from there and from test/token-metadata.test.mjs, which
// pins the same bytes against the Rust oracle).
const ORACLE = [
  'd2e11ea258b84d8d09000000617474656e74696f6e030000006174745000000068747470733a2f2f697066732e696f2f697066732f6261666b726569613273696535346a796e65333371783769767878626e6f68716e683273746b647662706974717867787966347a7a676467673734',
  'd2e11ea258b84d8d0600000043484152434f0600000043484152434f5000000068747470733a2f2f697066732e696f2f697066732f6261666b726569656f343379666d62676866696d6a33346f36737261746b76796f77786e3435346767713270693379717534776d346b35776c3469',
  'd2e11ea258b84d8d0a00000063686172636f2e66756e0600000043484152434f5000000068747470733a2f2f697066732e696f2f697066732f6261666b72656963696a376d76346d6172766d707069746771716e65366b767a63626f72703533736870707a77366b71677a78337a357865656134',
  'd7e4a6e45464567b0000000000000000000000000000000000000000000000000000000000000000',
];

/** Every Token-2022 payload the committed ecosystem sample names as metadata. */
function fixtureMetadataPayloads() {
  const sample = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json'), 'utf8'));
  const rows = [];
  for (const tx of sample.transactions ?? []) {
    for (const payload of tx.payloads ?? []) {
      if (payload.program !== TOKEN_2022) continue;
      const bytes = Buffer.from(payload.dataHex, 'hex');
      let decoded;
      try {
        decoded = t.decodeTokenInstruction(TOKEN_2022, bytes, { trailing: 'report' });
      } catch { continue; }
      if (decoded.scheme === 'native-token-metadata') rows.push(bytes);
    }
  }
  return rows;
}

/** A real TransferChecked payload from the same committed sample (G3). */
function fixtureTransferChecked() {
  const sample = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json'), 'utf8'));
  for (const tx of sample.transactions ?? []) {
    for (const payload of tx.payloads ?? []) {
      if (payload.program !== TOKEN_2022) continue;
      const bytes = Buffer.from(payload.dataHex, 'hex');
      let decoded;
      try {
        decoded = t.decodeTokenInstruction(TOKEN_2022, bytes, { trailing: 'report' });
      } catch { continue; }
      if (decoded.name === 'TransferChecked') return bytes;
    }
  }
  return null;
}

let t;
let m;

test.before(async () => {
  t = await import(path.join(ROOT, 'src', 'token.mjs'));
  m = await import(path.join(ROOT, 'src', 'token-metadata.mjs'));
});

test('D1: every name tokenNames() advertises is encodable-or-arg-refused, never unknown-variant', async () => {
  const names = t.tokenNames(TOKEN_2022);
  const unknownVariant = [];
  const outcome = {};
  for (const name of names) {
    try {
      t.encodeTokenInstruction(TOKEN_2022, name, {});
      outcome[name] = 'encoded';
    } catch (error) {
      outcome[name] = error.reason;
      if (error.reason === 'unknown-variant') unknownVariant.push(name);
    }
  }
  assert.deepEqual(unknownVariant, [],
    `the table claims these names but the encoder calls them unknown: ${unknownVariant.join(', ')}`);
  // The five metadata names are advertised — with no args they must be a
  // SHAPE refusal (missing-arg) or a successful encode, never unknown.
  for (const name of METADATA_NAMES) {
    assert.ok(names.includes(name), `${name} must be advertised by tokenNames`);
    assert.ok(outcome[name] === 'encoded' || outcome[name] === 'missing-arg',
      `${name} must encode or refuse its SHAPE, got ${outcome[name]}`);
  }
});

test('D2: the committed mainnet metadata payloads re-encode byte-exactly through the token API', async () => {
  const payloads = fixtureMetadataPayloads();
  assert.ok(payloads.length >= 10,
    `the committed sample must carry the metadata payloads; found ${payloads.length}`);
  const failures = [];
  for (const bytes of payloads) {
    const decoded = t.decodeTokenInstruction(TOKEN_2022, bytes, { trailing: 'report' });
    try {
      const re = t.encodeTokenInstruction(TOKEN_2022, decoded.name, decoded.args);
      if (!re.equals(bytes)) failures.push(`${decoded.name}: not byte-exact`);
    } catch (error) {
      failures.push(`${decoded.name}: ${error.reason}`);
    }
  }
  assert.deepEqual(failures, [],
    `${payloads.length} payloads decode but do not re-encode: ${JSON.stringify(failures)}`);
});

test('D3: the chain-witnessed oracle payloads re-encode byte-exactly through the token API', async () => {
  const failures = [];
  for (const hex of ORACLE) {
    const bytes = Buffer.from(hex, 'hex');
    const decoded = t.decodeTokenInstruction(TOKEN_2022, bytes, { trailing: 'report' });
    try {
      const re = t.encodeTokenInstruction(TOKEN_2022, decoded.name, decoded.args);
      if (!re.equals(bytes)) failures.push(`${decoded.name}: not byte-exact`);
    } catch (error) {
      failures.push(`${decoded.name}: ${error.reason}`);
    }
  }
  assert.deepEqual(failures, [], `oracle witnesses refused: ${JSON.stringify(failures)}`);
});

test('D4: a wrapped fallback refusal names its reason exactly once', async () => {
  // A trailing byte after UpdateAuthority: the fallback refuses it, and the
  // token module's wrapper must not repeat the reason in front of itself.
  const bytes = Buffer.from(`${'d7e4a6e45464567b'}${'00'.repeat(32)}00`, 'hex');
  let message = null;
  let reason = null;
  try {
    t.decodeTokenInstruction(TOKEN_2022, bytes, { trailing: 'report' });
  } catch (error) {
    message = error.message;
    reason = error.reason;
  }
  assert.ok(message, 'the trailing byte must be refused');
  assert.equal(reason, 'trailing-bytes');
  assert.ok(message.startsWith('trailing-bytes: '),
    `the voice must lead with its reason: ${message}`);
  assert.ok(!message.includes('trailing-bytes: trailing-bytes'),
    `the reason is printed twice: ${message}`);

  // The same normalization on the ENCODE path: a metadata name with a
  // missing argument is one reason, not two.
  let encodeMessage = null;
  try {
    t.encodeTokenInstruction(TOKEN_2022, 'Initialize', {});
  } catch (error) {
    encodeMessage = error.message;
  }
  assert.ok(encodeMessage, 'Initialize without arguments must refuse');
  assert.ok(encodeMessage.startsWith('missing-arg: '),
    `the voice must lead with its reason: ${encodeMessage}`);
  assert.ok(!encodeMessage.includes('missing-arg: missing-arg'),
    `the reason is printed twice: ${encodeMessage}`);
});

test('G1: legacy SPL Token still refuses every metadata name (the fallback is Token-2022 only)', () => {
  for (const name of METADATA_NAMES) {
    assert.throws(
      () => t.encodeTokenInstruction(SPL_TOKEN, name, { name: 'a', symbol: 'b', uri: 'c' }),
      (error) => error.reason === 'unknown-variant',
      `legacy SPL Token must not encode the metadata name ${name}`,
    );
    assert.equal(t.isTokenName(SPL_TOKEN, name), false,
      `legacy SPL Token must not advertise ${name}`);
  }
});

test('G2: a name neither table declares is still unknown-variant', () => {
  assert.throws(
    () => t.encodeTokenInstruction(TOKEN_2022, 'NotARealInstruction', {}),
    (error) => error.reason === 'unknown-variant',
  );
  assert.equal(t.isTokenName(TOKEN_2022, 'NotARealInstruction'), false);
});

test('G3: the token table itself is untouched — TransferChecked still round-trips byte-exactly', () => {
  const bytes = fixtureTransferChecked();
  assert.ok(bytes, 'the committed sample must carry a TransferChecked payload');
  const decoded = t.decodeTokenInstruction(TOKEN_2022, bytes, { trailing: 'report' });
  assert.equal(decoded.name, 'TransferChecked');
  assert.equal(decoded.roundTripByteExact, true);
  const re = t.encodeTokenInstruction(TOKEN_2022, decoded.name, decoded.args);
  assert.ok(re.equals(bytes), 'the token-table path must be byte-identical');
  // 48 token names + 5 metadata names, and the split is exactly the fallback.
  const names = t.tokenNames(TOKEN_2022);
  assert.equal(names.length, 53, '48 token variants + 5 metadata variants');
  assert.equal(m.tokenMetadataNames().length, 5);
  assert.equal(
    names.filter((name) => !m.tokenMetadataNames().includes(name)).length, 48,
    'the token-table half is unchanged');
});

test('G4: the decoder reasons are unchanged by the encoder fix', () => {
  // Unknown 8-byte discriminator -> the fallback's own named refusal.
  // First byte 0xd0 is not a token variant, so the payload reaches the
  // metadata table, whose discriminator does not match.
  assert.throws(
    () => t.decodeTokenInstruction(TOKEN_2022, Buffer.from(`d0e11ea258b84d8d${'00'.repeat(32)}`, 'hex')),
    (error) => error.reason === 'unknown-selector',
  );
  // A payload whose first byte IS a token variant never reaches the
  // fallback (upstream's dispatch order) — it stays a token-table refusal.
  // Tag 3 is Transfer on BOTH token programs (tag + u64), so four bytes
  // refuse inside the TOKEN table, not in the metadata fallback.
  assert.throws(
    () => t.decodeTokenInstruction(TOKEN_2022, Buffer.from([3, 1, 2, 3])),
    (error) => error.reason === 'truncated-u64',
  );
  // Transfer is 9 bytes on the wire (tag + u64) — four bytes must refuse.
  assert.throws(
    () => t.decodeTokenInstruction(SPL_TOKEN, Buffer.from([3, 1, 2, 3])),
    (error) => error.reason === 'truncated-u64',
  );
  // The refusal voice through the wrapper keeps ONE reason.
  assert.equal(
    t.tokenRefusal(TOKEN_2022, Buffer.from(`${'d7e4a6e45464567b'}${'00'.repeat(32)}00`, 'hex')),
    'trailing-bytes');
});
