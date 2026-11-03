import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The token tables (SPL Token + Token-2022) are DERIVED from the vendored
 * upstream Rust crates (`src/token-interface.mjs`), committed as reviewable
 * artifacts (`interface/token-<program>.json`), and re-derived AT LOAD: the
 * module refuses to decode unless the committed artifact equals a fresh
 * derivation of the vendored bytes.
 *
 * These tests pin that contract by mutation, not by assertion:
 *
 *   1. The committed artifacts are exactly today's derivation (a stale
 *      artifact fails the CLI check, so nobody approves a table nobody
 *      regenerated).
 *   2. A tampered ARTIFACT row refuses the load — the decode comes from the
 *      derivation, never from the artifact's own bytes, so editing a row
 *      cannot change what decodes.
 *   3. A tampered VENDORED SOURCE refuses the load (the hash the artifact
 *      claims).
 *   4. A MISSING vendored source refuses the load.
 *   5. The wire shapes are upstream's own: a field order swap in the vendored
 *      pack() arm flips which args a variant decodes — the test pins the real
 *      measured payloads, so a swapped order cannot pass.
 *
 * Falsification of the tests themselves: removing the load-time equality
 * check turns 2 and 3 into silent passes; the runtime would then decode from
 * whichever copy won.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SAMPLE = path.join(ROOT, 'test', 'fixtures', 'traffic-sample-2026-11-02.json');

/** A throwaway copy of everything `src/token.mjs` reads at load time. */
function copyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-token-'));
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

test('the committed token artifacts are exactly what the derivation produces', () => {
  const out = execFileSync(process.execPath, ['tools/token-interface.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 2, 'both token programs must be checked');
  for (const line of lines) assert.match(line, /: current \(\d+ variants, sha256:[0-9a-f]{64}\)/);
});

test('a tampered ARTIFACT refuses the load (decode comes from the derivation)', async () => {
  const dir = copyRepo();
  try {
    const file = path.join(dir, 'interface', `token-${SPL_TOKEN}.json`);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Swap the field order of TransferChecked: amount then decimals on the
    // wire becomes decimals then amount. Byte-order lies, not style.
    const transfer = doc.instructions.find((ix) => ix.name === 'TransferChecked');
    assert.ok(transfer, 'TransferChecked must be in the table');
    transfer.args.reverse();
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    await assert.rejects(loadFrom(dir), /refuses to load/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tampered VENDORED SOURCE refuses the load (the claimed hash)', async () => {
  const dir = copyRepo();
  try {
    const file = path.join(dir, 'vendor', 'spl-token',
      '737788ff5bcc3f1f44cfb222f25483187650be76', 'interface', 'src', 'instruction.rs');
    fs.appendFileSync(file, '\n// tampered: an extra byte write in a pack arm\n');
    await assert.rejects(loadFrom(dir), /does not equal a fresh derivation/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a MISSING vendored source refuses the load', async () => {
  const dir = copyRepo();
  try {
    fs.rmSync(path.join(dir, 'vendor', 'spl-token-2022'), { recursive: true, force: true });
    await assert.rejects(loadFrom(dir), /not found|ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the derivation reads upstream\'s own wire, not a transcription', async () => {
  const { deriveTokenInterface, TOKEN_SPECS } = await import(path.join(ROOT, 'src', 'token-interface.mjs'));
  const [legacy, t22] = TOKEN_SPECS.map((spec) => deriveTokenInterface(spec));

  // SPL Token: 28 variants, explicit tags — WithdrawExcessLamports is 38 and
  // UnwrapLamports is 45, which declaration order would get wrong (25, 26).
  assert.equal(legacy.instructions.length, 28);
  const names = new Map(legacy.instructions.map((ix) => [ix.name, ix.tag]));
  assert.equal(names.get('WithdrawExcessLamports'), 38, 'upstream writes 38, not the declaration index 25');
  assert.equal(names.get('UnwrapLamports'), 45, 'upstream writes 45, not the declaration index 26');
  assert.equal(names.get('Batch'), 255);

  // The measured wire shapes: TransferChecked is amount(u64) THEN decimals(u8)
  // — the order upstream pack() writes them.
  const checked = legacy.instructions.find((ix) => ix.name === 'TransferChecked');
  assert.deepEqual(checked.args, [
    { name: 'amount', type: 'u64' },
    { name: 'decimals', type: 'u8' },
  ]);
  // InitializeMint writes decimals first, then mint_authority, then the
  // C-style option freeze_authority (NOT a bincode option wrapper).
  const initMint = legacy.instructions.find((ix) => ix.name === 'InitializeMint');
  assert.deepEqual(initMint.args, [
    { name: 'decimals', type: 'u8' },
    { name: 'mint_authority', type: 'pubkey' },
    { name: 'freeze_authority', type: 'coption_pubkey' },
  ]);
  // SetAuthority carries the AuthorityType byte, which must decode by name.
  const setAuthority = legacy.instructions.find((ix) => ix.name === 'SetAuthority');
  assert.deepEqual(setAuthority.args, [
    { name: 'authority_type', type: 'authority_type' },
    { name: 'new_authority', type: 'coption_pubkey' },
  ]);
  // UnwrapLamports takes an Option<u64> in the C-style encoding.
  const unwrap = legacy.instructions.find((ix) => ix.name === 'UnwrapLamports');
  assert.deepEqual(unwrap.args, [{ name: 'amount', type: 'coption_u64' }]);

  // Token-2022 is a superset: 48 variants, including the extension tags.
  assert.equal(t22.instructions.length, 48);
  const t22Names = new Map(t22.instructions.map((ix) => [ix.name, ix.tag]));
  assert.equal(t22Names.get('InitializeMintCloseAuthority'), 25);
  assert.equal(t22Names.get('PermissionedBurnExtension'), 46);
  // Token-2022's GetAccountDataSize takes extension types as a u16 run.
  const size = t22.instructions.find((ix) => ix.name === 'GetAccountDataSize');
  assert.deepEqual(size.args, [{ name: 'extension_types', type: 'u16_vec' }]);
  // Batch on Token-2022 carries raw data bytes (upstream pack writes them;
  // the PROCESSOR then refuses the tag — a wire fact, not a runtime claim).
  const batch = t22.instructions.find((ix) => ix.name === 'Batch');
  assert.deepEqual(batch.args, [{ name: 'data', type: 'bytes' }]);

  // The AuthorityType list is derived too: Token-2022 has 18 variants,
  // legacy SPL Token has 4.
  assert.equal(legacy.authorityType.length, 4);
  assert.equal(t22.authorityType.length, 18);
  assert.deepEqual(t22.authorityType[0], { byte: 0, name: 'MintTokens' });
  assert.deepEqual(t22.authorityType[17], { byte: 17, name: 'PermissionedBurn' });
});

test('real mainnet token payloads decode byte-exactly through the product', async () => {
  const { decodeTokenInstruction, isTokenProgram } = await import(path.join(ROOT, 'src', 'token.mjs'));
  assert.equal(isTokenProgram(SPL_TOKEN), true);
  assert.equal(isTokenProgram(TOKEN_2022), true);

  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  let total = 0, decoded = 0, exact = 0, refused = 0;
  const refusalKinds = new Map();
  const names = new Map();
  for (const tx of sample.transactions) {
    for (const row of tx.payloads) {
      if (row.program !== SPL_TOKEN && row.program !== TOKEN_2022) continue;
      total += 1;
      try {
        const result = decodeTokenInstruction(row.program, Buffer.from(row.dataHex, 'hex'));
        decoded += 1;
        if (result.roundTripByteExact) exact += 1;
        names.set(result.name, (names.get(result.name) ?? 0) + 1);
      } catch (error) {
        refused += 1;
        refusalKinds.set(error.reason, (refusalKinds.get(error.reason) ?? 0) + 1);
      }
    }
  }
  assert.equal(total, 5402, 'the two token programs carry 5,402 payloads in the sample');
  assert.equal(decoded, 5402, 'every payload decodes — the token-metadata fallback included');
  assert.equal(exact, 4980, 'the byte-exact re-encode count on real wire');
  assert.equal(refused, 0);
  // The token-metadata fallback that used to be refused as `unknown-selector`
  // now decodes through the SECOND table Token-2022's processor consults —
  // because that is what the program does with those bytes. Its name comes
  // from upstream's own variant list. This sample carries exactly one such
  // payload (an Initialize); the UpdateAuthority form appears in the
  // 2026-11-03 sample and is pinned by test/token-metadata.test.mjs.
  assert.deepEqual([...refusalKinds.keys()], []);
  assert.equal(names.get('Initialize'), 1, 'the token-metadata Initialize payload decodes by name');
  // The most frequent money-movement instructions are named by upstream's
  // own variant names.
  assert.ok((names.get('TransferChecked') ?? 0) > 1000, 'TransferChecked is the traffic');
  assert.ok((names.get('CloseAccount') ?? 0) > 700);
  assert.ok((names.get('InitializeAccount3') ?? 0) > 600);
});

test('unknown selectors and truncated payloads refuse with named reasons', async () => {
  const { decodeTokenInstruction, TokenCodecError } = await import(path.join(ROOT, 'src', 'token.mjs'));
  // Tag 210 is not in the pinned table (it is the metadata fallback's first
  // discriminator byte) — refusal, not a guess.
  assert.throws(
    () => decodeTokenInstruction(TOKEN_2022, Buffer.concat([Buffer.from([210]), Buffer.alloc(130)])),
    (error) => error instanceof TokenCodecError && error.reason === 'unknown-selector',
  );
  // Transfer is 9 bytes on the wire (tag + u64); 4 bytes must refuse.
  assert.throws(
    () => decodeTokenInstruction(SPL_TOKEN, Buffer.from([3, 1, 2, 3])),
    (error) => error instanceof TokenCodecError && error.reason === 'truncated-u64',
  );
  // An option tag of 2 is not one upstream writes (0 or 1).
  assert.throws(
    () => decodeTokenInstruction(SPL_TOKEN, Buffer.concat([
      Buffer.from([0]), Buffer.from([9]), Buffer.alloc(32), Buffer.from([2]),
    ])),
    (error) => error instanceof TokenCodecError && error.reason === 'invalid-coption-tag',
  );
  // A non-token program never enters the table.
  const other = decodeTokenInstruction('11111111111111111111111111111111', Buffer.from([0]));
  assert.equal(other.refused, 'not-token');
});

test('the observed amount bytes decode as the real numbers (measured wire)', async () => {
  const { decodeTokenInstruction } = await import(path.join(ROOT, 'src', 'token.mjs'));
  // 40 42 0f 00 00 00 00 00 is 1_000_000 LE (from the sample's Transfer rows).
  const transfer = decodeTokenInstruction(SPL_TOKEN, Buffer.concat([
    Buffer.from([3]),
    Buffer.from('40420f0000000000', 'hex'),
  ]));
  assert.equal(transfer.name, 'Transfer');
  assert.equal(transfer.args.amount, 1000000n);
  assert.equal(transfer.roundTripByteExact, true);

  // TransferChecked: amount then decimals then — no more bytes.
  const checked = decodeTokenInstruction(SPL_TOKEN, Buffer.concat([
    Buffer.from([12]),
    Buffer.from('40420f0000000000', 'hex'),
    Buffer.from([6]),
  ]));
  assert.equal(checked.args.amount, 1000000n);
  assert.equal(checked.args.decimals, 6);
  assert.equal(checked.roundTripByteExact, true);

  // SetAuthority: byte 0 = MintTokens, option tag 1 + a pubkey.
  const authority = decodeTokenInstruction(SPL_TOKEN, Buffer.concat([
    Buffer.from([6, 0, 1]),
    Buffer.alloc(32, 7),
  ]));
  assert.equal(authority.args.authority_type, 0);
  assert.equal(authority.authorityType, 'MintTokens');
  assert.equal(authority.roundTripByteExact, true);
});
