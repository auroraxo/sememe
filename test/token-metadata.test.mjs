// The SPL Token-Metadata fallback: Token-2022's SECOND instruction table.
//
// Why this file exists: Token-2022's processor (program/src/processor.rs at
// the pinned revision) tries the ONE-BYTE PodTokenInstruction selector
// first and, when that fails, falls through to
// `TokenMetadataInstruction::unpack(input)`. A metadata instruction
// therefore carries an EIGHT-BYTE discriminator and never matches the token
// table's 1-byte tags — sememe used to refuse those payloads as
// `unknown-selector`, which was a true statement about the token table and
// a FALSE statement about the program.
//
// These tests pin that contract by mutation, not by assertion:
//
//   1. The committed artifact is exactly today's derivation (a stale
//      artifact fails the CLI check, so nobody approves a table nobody
//      regenerated).
//   2. A tampered ARTIFACT refuses the load — the decode comes from the
//      derivation, never from the artifact's own bytes.
//   3. A tampered VENDORED SOURCE refuses the load (the hash the artifact
//      claims).
//   4. A MISSING vendored source refuses the load.
//   5. The wire shapes are upstream's own: the OBSERVED mainnet payloads
//      decode and re-encode byte-exactly, an unknown 8-byte discriminator
//      still refuses, and a trailing byte still refuses — because upstream's
//      `unpack` calls `try_from_slice`, which refuses trailing bytes.
//
// The upstream behaviour was VERIFIED, not assumed: the wire forms were
// cross-checked against a Rust program built from the exact pinned crates
// (spl-token-metadata-interface 1.0.1, spl-discriminator 0.5.2,
// solana-nullable 1.3.0, borsh 1.8.1). See research/token-metadata-oracle-2026-11-03.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const VENDOR = path.join('vendor', 'spl-token-metadata-interface', '7038969ec74a89f1afdb9bc97c112d4d26fead9a');

// The OBSERVED mainnet payloads (research/short-form-wire-forms-2026-11-03b.json,
// witnesses at slot 464868999). These are real bytes the chain executed.
const OBSERVED = {
  initializeAttention:
    'd2e11ea258b84d8d09000000617474656e74696f6e030000006174745000000068747470733a2f2f697066732e696f2f697066732f6261666b726569613273696535346a796e65333371783769767878626e6f68716e683273746b647662706974717867787966347a7a676467673734',
  initializeCharco:
    'd2e11ea258b84d8d0600000043484152434f0600000043484152434f5000000068747470733a2f2f697066732e696f2f697066732f6261666b726569656f343379666d62676866696d6a33346f36737261746b76796f77786e3435346767713270693379717534776d346b35776c3469',
  initializeCharcoFun:
    'd2e11ea258b84d8d0a00000063686172636f2e66756e0600000043484152434f5000000068747470733a2f2f697066732e696f2f697066732f6261666b72656963696a376d76346d6172766d707069746771716e65366b767a63626f72703533736870707a77366b71677a78337a357865656134',
  updateAuthorityNone:
    'd7e4a6e45464567b0000000000000000000000000000000000000000000000000000000000000000',
};

/** A throwaway copy of everything the token modules read at load time. */
function copyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-md-'));
  for (const part of ['src', 'interface', 'vendor']) {
    fs.cpSync(path.join(ROOT, part), path.join(dir, part), { recursive: true });
  }
  return dir;
}

/** Import `src/token.mjs` from a copy; the load-time check runs on import. */
function loadFrom(dir) {
  const target = `${pathToFileURL(path.join(dir, 'src', 'token.mjs')).href}?t=${Date.now()}-${Math.random()}`;
  return import(target);
}

test('the committed metadata artifact is exactly what the derivation produces', () => {
  const out = execFileSync(process.execPath, ['tools/token-metadata-interface.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(out.trim(), /: current \(\d+ variants, sha256:[0-9a-f]{64}\)/);
});

test('the derivation reads upstream\'s own wire, not a transcription', async () => {
  const { deriveTokenMetadataInterface } = await import(path.join(ROOT, 'src', 'token-metadata-interface.mjs'));
  const doc = deriveTokenMetadataInterface();

  assert.equal(doc.instructions.length, 5, 'upstream declares five metadata instructions');
  const byName = new Map(doc.instructions.map((ix) => [ix.name, ix]));

  // The discriminators are upstream's own hash inputs, and they are the ones
  // the chain executed — sha256(namespace:action)[..8].
  assert.equal(byName.get('Initialize').discriminator, 'd2e11ea258b84d8d');
  assert.equal(byName.get('UpdateField').discriminator, 'dde9312db5cadcc8');
  assert.equal(byName.get('RemoveKey').discriminator, 'ea122038598d25b5');
  assert.equal(byName.get('UpdateAuthority').discriminator, 'd7e4a6e45464567b');
  assert.equal(byName.get('Emit').discriminator, 'faa6b4fa0d0cb846');

  // Initialize is three Borsh strings, in the struct's declaration order.
  assert.deepEqual(byName.get('Initialize').args, [
    { name: 'name', type: 'borsh_string' },
    { name: 'symbol', type: 'borsh_string' },
    { name: 'uri', type: 'borsh_string' },
  ]);
  // RemoveKey: the BOOL comes FIRST. Upstream's struct declares
  // `idempotent: bool` before `key: String`, and upstream's own unpack()
  // skips 1 byte for the bool before reading the string. A swap would be a
  // silent mislabel.
  assert.deepEqual(byName.get('RemoveKey').args, [
    { name: 'idempotent', type: 'borsh_bool' },
    { name: 'key', type: 'borsh_string' },
  ]);
  // UpdateAuthority is a MaybeNull<Address>: the TRANSPARENT 32 bytes, with
  // NO option tag — the all-zero address means None.
  assert.deepEqual(byName.get('UpdateAuthority').args, [
    { name: 'new_authority', type: 'maybe_null_address' },
  ]);
  // Emit carries two Borsh options (1 tag byte + payload), not C-style ones.
  assert.deepEqual(byName.get('Emit').args, [
    { name: 'start', type: 'borsh_option_u64' },
    { name: 'end', type: 'borsh_option_u64' },
  ]);
  // The Field enum is derived from upstream's own declaration: the tag is the
  // declaration index, and only Key carries a nested string.
  assert.deepEqual(doc.fieldEnum, [
    { tag: 0, name: 'Name', payload: null },
    { tag: 1, name: 'Symbol', payload: null },
    { tag: 2, name: 'Uri', payload: null },
    { tag: 3, name: 'Key', payload: 'borsh_string' },
  ]);

  // The discriminator RULE is anchored by upstream's own hardcoded literal:
  // the TokenMetadata account's discriminator in state.rs must be what
  // sha256("<namespace>:token_metadata") produces, or every discriminator
  // would be wrong.
  assert.equal(doc.selector.width, 8);
  assert.equal(doc.source.pin, '7038969ec74a89f1afdb9bc97c112d4d26fead9a');
});

test('the OBSERVED mainnet metadata payloads decode and re-encode byte-exactly', async () => {
  const { decodeTokenInstruction } = await import(path.join(ROOT, 'src', 'token.mjs'));

  const attention = decodeTokenInstruction(TOKEN_2022, Buffer.from(OBSERVED.initializeAttention, 'hex'));
  assert.equal(attention.name, 'Initialize');
  assert.equal(attention.selectorWidth, 8);
  assert.equal(attention.args.name, 'attention');
  assert.equal(attention.args.symbol, 'att');
  assert.equal(attention.args.uri,
    'https://ipfs.io/ipfs/bafkreia2sie54jyne33qx7ivxxbnohqnh2stkdvbpitqxgxyf4zzgdgg74');
  assert.equal(attention.roundTripByteExact, true);
  assert.equal(attention.consumed, attention.bytes, 'the payload is fully explained');

  const charco = decodeTokenInstruction(TOKEN_2022, Buffer.from(OBSERVED.initializeCharco, 'hex'));
  assert.equal(charco.name, 'Initialize');
  assert.equal(charco.args.name, 'CHARCO');
  assert.equal(charco.roundTripByteExact, true);

  const charcoFun = decodeTokenInstruction(TOKEN_2022, Buffer.from(OBSERVED.initializeCharcoFun, 'hex'));
  assert.equal(charcoFun.name, 'Initialize');
  assert.equal(charcoFun.args.name, 'charco.fun');
  assert.equal(charcoFun.args.symbol, 'CHARCO');
  assert.equal(charcoFun.roundTripByteExact, true);

  // UpdateAuthority with the all-zero address: MaybeNull's None.
  const authority = decodeTokenInstruction(TOKEN_2022, Buffer.from(OBSERVED.updateAuthorityNone, 'hex'));
  assert.equal(authority.name, 'UpdateAuthority');
  assert.equal(authority.args.new_authority, null, 'the all-zero address is MaybeNull::None');
  assert.equal(authority.roundTripByteExact, true);
});

test('the fallback is reached ONLY where upstream reaches it', async () => {
  const { decodeTokenInstruction, tokenRefusal, hasTokenMetadataFallback } =
    await import(path.join(ROOT, 'src', 'token.mjs'));

  // Token-2022 falls through; legacy SPL Token has no such branch.
  assert.equal(hasTokenMetadataFallback(TOKEN_2022), true);
  assert.equal(hasTokenMetadataFallback(SPL_TOKEN), false);

  // The same metadata bytes on legacy SPL Token must still refuse — upstream's
  // legacy processor never tries the metadata table.
  assert.equal(tokenRefusal(SPL_TOKEN, Buffer.from(OBSERVED.initializeAttention, 'hex')), 'unknown-selector');

  // The ONE-BYTE selector wins when it applies: upstream tries the token
  // type FIRST, and only a failed type decode reaches the metadata table.
  const initializeMintBytes = Buffer.concat([
    Buffer.from([0, 6]),              // tag 0, decimals 6
    Buffer.alloc(32, 9),              // mint_authority
    Buffer.from([1]),                 // COption::Some
    Buffer.alloc(32, 8),              // freeze_authority
  ]);
  const initializeMint = decodeTokenInstruction(TOKEN_2022, initializeMintBytes);
  assert.equal(initializeMint.name, 'InitializeMint');
  assert.equal(initializeMint.selectorWidth, 1);
  assert.equal(initializeMint.roundTripByteExact, true);
});

test('unknown 8-byte discriminators and malformed bodies still refuse, by name', async () => {
  const { tokenRefusal } = await import(path.join(ROOT, 'src', 'token.mjs'));

  // An 8-byte discriminator that is neither a token tag nor a metadata one.
  assert.equal(tokenRefusal(TOKEN_2022, Buffer.from(`d0e11ea258b84d8d${'00'.repeat(32)}`, 'hex')), 'unknown-selector');
  assert.equal(tokenRefusal(TOKEN_2022, Buffer.from(`4ce11ea258b84d8d${'00'.repeat(40)}`, 'hex')), 'unknown-selector');

  // Too short to carry a discriminator at all.
  assert.equal(tokenRefusal(TOKEN_2022, Buffer.from('d7e4a6e4', 'hex')), 'truncated-discriminator');

  // A forged Borsh string length must not be trusted: upstream checks the
  // length against the remaining bytes before reading (check_borsh_string).
  assert.equal(tokenRefusal(TOKEN_2022, Buffer.from('d2e11ea258b84d8dff000000616263', 'hex')), 'truncated-string');

  // TRAILING BYTES ARE REFUSED, because upstream's unpack uses try_from_slice
  // and therefore refuses them. Verified against the upstream crate, where a
  // trailing byte is a BorshIoError. A decoder that named such a payload
  // would claim the chain accepts bytes the chain rejects.
  assert.equal(
    tokenRefusal(TOKEN_2022, Buffer.from(`${OBSERVED.updateAuthorityNone}aa`, 'hex')),
    'trailing-bytes',
  );
  assert.equal(
    tokenRefusal(TOKEN_2022, Buffer.from(`${OBSERVED.initializeAttention}00`, 'hex')),
    'trailing-bytes',
  );
});

test('the re-encode is byte-exact for every variant the table can build', async () => {
  const { encodeTokenMetadataInstruction } = await import(path.join(ROOT, 'src', 'token-metadata.mjs'));

  // UpdateField with a nested Field::Key string: the enum tag, then the
  // nested Borsh string, then the value string.
  const updateField = encodeTokenMetadataInstruction('UpdateField', {
    field: { variant: 'Key', value: 'custom' },
    value: 'v',
  });
  assert.equal(updateField.toString('hex'), 'dde9312db5cadcc80306000000637573746f6d0100000076');

  // RemoveKey: the bool byte comes FIRST, then the key string.
  assert.equal(
    encodeTokenMetadataInstruction('RemoveKey', { idempotent: true, key: 'k' }).toString('hex'),
    'ea122038598d25b501010000006b',
  );
  assert.equal(
    encodeTokenMetadataInstruction('RemoveKey', { idempotent: false, key: 'k' }).toString('hex'),
    'ea122038598d25b500010000006b',
  );

  // Emit: two Borsh options.
  assert.equal(
    encodeTokenMetadataInstruction('Emit', { start: null, end: null }).toString('hex'),
    'faa6b4fa0d0cb8460000',
  );
  assert.equal(
    encodeTokenMetadataInstruction('Emit', { start: 1n, end: 9n }).toString('hex'),
    'faa6b4fa0d0cb846010100000000000000010900000000000000',
  );

  // UpdateAuthority: Some is the raw address, None is the all-zero address.
  assert.equal(
    encodeTokenMetadataInstruction('UpdateAuthority', { new_authority: null }).toString('hex'),
    OBSERVED.updateAuthorityNone,
  );
});

test('a tampered ARTIFACT refuses the load (decode comes from the derivation)', async () => {
  const dir = copyRepo();
  try {
    const file = path.join(dir, 'interface', 'token-metadata.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Swap RemoveKey's field order: the bool moves behind the string. A
    // byte-order lie, not a style change.
    const removeKey = doc.instructions.find((ix) => ix.name === 'RemoveKey');
    assert.ok(removeKey, 'RemoveKey must be in the table');
    removeKey.args.reverse();
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    await assert.rejects(loadFrom(dir), /refuses to load/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tampered VENDORED SOURCE refuses the load (the claimed hash)', async () => {
  const dir = copyRepo();
  try {
    const file = path.join(dir, VENDOR, 'interface', 'src', 'instruction.rs');
    fs.appendFileSync(file, '\n// tampered: an extra field upstream does not have\n');
    await assert.rejects(loadFrom(dir), /does not equal a fresh derivation|refuses to load/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a MISSING vendored source refuses the load', async () => {
  const dir = copyRepo();
  try {
    fs.rmSync(path.join(dir, 'vendor', 'spl-token-metadata-interface'), { recursive: true, force: true });
    await assert.rejects(loadFrom(dir), /not found|ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the upstream oracle agrees with this table on every wire form', async () => {
  // research/token-metadata-oracle-2026-11-03.json holds the output of a
  // Rust program built from the EXACT pinned crates (spl-token-metadata-
  // interface 1.0.1, spl-discriminator 0.5.2, solana-nullable 1.3.0,
  // borsh 1.8.1). It is the upstream program itself, not a second reading of
  // the source — so it is a real falsifier of this derivation.
  const oracle = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'research', 'token-metadata-oracle-2026-11-03.json'), 'utf8',
  ));
  const { encodeTokenMetadataInstruction } = await import(path.join(ROOT, 'src', 'token-metadata.mjs'));

  // The discriminator rule: upstream's own hardcoded TokenMetadata literal.
  assert.equal(oracle.discriminatorRule.anchorLiteral, '70845a5a0b589d57');
  assert.equal(oracle.discriminatorRule.computedByOracle, oracle.discriminatorRule.anchorLiteral);
  // The same rule, computed here in JS from the namespace + suffix, must
  // reproduce that literal — this is the sha256 rule itself, checked
  // against upstream's own hardcoded bytes.
  const jsAnchor = createHash('sha256')
    .update(`${oracle.discriminatorRule.namespace}:token_metadata`)
    .digest('hex').slice(0, 16);
  assert.equal(jsAnchor, oracle.discriminatorRule.anchorLiteral,
    'the sha256(namespace:action)[..8] rule does not reproduce upstream\'s literal');

  // The FIVE instruction discriminators, computed by the crate's OWN
  // SplDiscriminate derive macro. sememe's derivation (sha256 of upstream's
  // own hash-input string) must produce the same 8 bytes — this is the
  // falsifier for the derivation itself, not for a transcription of it.
  const { deriveTokenMetadataInterface } = await import(path.join(ROOT, 'src', 'token-metadata-interface.mjs'));
  const derived = deriveTokenMetadataInterface();
  for (const ix of derived.instructions) {
    assert.equal(
      oracle.discriminatorRule.instructionDiscriminators[ix.name],
      ix.discriminator,
      `${ix.name}: sememe's derived discriminator differs from the upstream crate's`,
    );
  }

  // Every variant the oracle packed must be byte-identical to what this
  // table builds from the SAME inputs.
  for (const entry of oracle.packed) {
    const mine = encodeTokenMetadataInstruction(entry.name, entry.args).toString('hex');
    assert.equal(mine, entry.hex, `${entry.name}: sememe's re-encode differs from the upstream crate`);
  }

  // The oracle's refusal cases must be refusals here too — with the SAME
  // reason, so the table's strictness matches upstream's, not just its
  // acceptance.
  for (const entry of oracle.refused) {
    const bytes = Buffer.from(entry.hex, 'hex');
    const { decodeTokenMetadataInstruction, TokenMetadataCodecError } =
      await import(path.join(ROOT, 'src', 'token-metadata.mjs'));
    assert.throws(
      () => decodeTokenMetadataInstruction(TOKEN_2022, bytes),
      (error) => error instanceof TokenMetadataCodecError && error.reason === entry.reason,
      `${entry.label}: upstream refuses this (${entry.upstreamError}), so sememe must too`,
    );
  }

  // The OBSERVED mainnet payloads: the upstream crate unpacked them and
  // re-encoded them byte-identically, so sememe's decode of the same bytes
  // is a decode of a payload the chain accepts.
  for (const entry of oracle.observed) {
    assert.equal(entry.accepted, true, `${entry.label}: upstream must accept it`);
    assert.equal(entry.reencodeEqual, true, `${entry.label}: upstream re-encodes it byte-identically`);
    const { decodeTokenMetadataInstruction } = await import(path.join(ROOT, 'src', 'token-metadata.mjs'));
    const decoded = decodeTokenMetadataInstruction(TOKEN_2022, Buffer.from(entry.hex, 'hex'));
    assert.equal(decoded.name, entry.name);
    assert.equal(decoded.roundTripByteExact, true);
  }
});
