// A published copy that RENAMES an account must not be reported as "no such
// account".
//
// WHY THIS FILE EXISTS — measured 2026-11-08 on 12 real mainnet meteora-vault
// accounts (research/account-union-cross-2026-11-08.json):
//
// The meteora-vault program's two committed interface copies describe the SAME
// account under different names:
//
//     on-chain copy (metadata)      "Vault"   -> Anchor derives d308e82b02987577
//     published copy                "vault"   -> Anchor derives ded54f7cd8eeee83
//
// The deployed bytes carry the on-chain discriminator. The published copy's
// account table therefore never matches them, and `sememe account --union`
// reported the second source as:
//
//     no account type in this source matches the first 8 bytes (d308e82b...)
//
// which is true of the DISCRIMINATOR but false as a description of the copy:
// the copy declares this account — under a different spelling. Anchor derives
// an account discriminator from the EXACT name, so a renamed copy can never
// identify the deployed bytes, whatever its layout says. The user is entitled
// to see that, instead of a reason that reads as "the second source does not
// know this account at all".
//
// WHAT IS PINNED HERE:
//
//  R1  the VERDICT is unchanged: `primary_only`, the on-chain copy answers.
//      The diagnosis must not turn into an answer, a fallback, or a refusal of
//      the account — plain and union must both still decode it.
//  R2  the refusal reason NAMES the rename: both spellings, and the fact that
//      the discriminator is derived from the exact name (the mechanism that
//      makes the copy unable to match).
//  R3  the control keeps the generic reason: a source that genuinely does not
//      declare the account (pump.fun's second copy against bytes no copy
//      declares) must not gain a rename diagnosis it does not have.
//  R4  the direction is symmetric: when the SECONDARY identifies and the
//      PRIMARY cannot, the primary's reason carries the same diagnosis.
//
// WHAT THIS MUST NOT DO (the traps):
//
//  * force-decode the renamed copy and let byte evidence arbitrate — two names
//    for the same account bytes is a HARD refusal (A3 in
//    test/account-union.test.mjs), so a forced decode would turn
//    `primary_only` into `name_conflict` and take away an answer the plain
//    path gives: a regression the cross-measurement invariant
//    `unionRefusedWherePlainAnswered` is built to catch;
//  * pick the renamed copy as winner because its layout explains more bytes —
//    the verdict must stay `primary_only` (R1);
//  * invent a rename where none exists (R3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/canonical.mjs';
import { adopt } from '../src/adopt.mjs';
import { decodeStoredAccount, decodeUnionStoredAccount } from '../src/decode.mjs';
import { unionAccountDecode } from '../src/account-union.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

const PROGRAM = '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi';

const load = async (name) => JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8'));
const onchain = await load('meteora-vault-idl.json');
const published = await load('meteora-vault-published-idl.json');
const accounts = await load('accounts-meteora-vault-2026-11-08.json');

// The two spellings of the same account, and their Anchor-derived
// discriminators — the whole reason a renamed copy cannot identify deployed
// bytes. Asserted so the fixture cannot quietly change under the test.
assert.equal(onchain.accounts.find((a) => a.name === 'Vault')?.discriminator?.length ?? 0, 0,
  'the on-chain copy stores no discriminator (Anchor derives it from the name)');
assert.ok(published.accounts.some((a) => a.name === 'vault'),
  'the published copy spells the account in lowercase');

const vaultAccount = accounts.accounts.find((a) => {
  const head = Buffer.from(a.dataBase64, 'base64').subarray(0, 8).toString('hex');
  return head === 'd308e82b02987577';
});
assert.ok(vaultAccount, 'the harvest must contain a Vault account');

/** A store with the on-chain copy as a pull and the published copy adopted. */
async function store() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-account-union-rename-'));
  await mkdir(path.join(dir, 'objects'), { recursive: true });
  await mkdir(path.join(dir, 'receipts'), { recursive: true });
  const bytes = Buffer.from(canonicalJson(onchain) + '\n');
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(dir, 'objects', `${fingerprint}.json`), bytes);
  await writeFile(
    path.join(dir, 'receipts', `${PROGRAM}-466833000-metadata-${fingerprint}.json`),
    Buffer.from(canonicalJson({
      program: PROGRAM, source: 'metadata', slot: 466833000,
      fingerprint: `sha256:${fingerprint}`, instructionCount: onchain.instructions.length,
    }) + '\n'),
  );
  const file = path.join(dir, 'published.json');
  await writeFile(file, JSON.stringify(published));
  await adopt(PROGRAM, file, dir, { source: 'published', origin: 'meteora-vault-published-idl.json' });
  return dir;
}

test('R1: the verdict stays primary_only — a diagnosis must not change the answer', async () => {
  const dir = await store();
  try {
    // The plain path decodes this account; so must the union path. Losing it
    // would be a regression against the path the feature replaced.
    const plain = await decodeStoredAccount(dir, PROGRAM, vaultAccount.dataBase64);
    assert.equal(plain.account, 'Vault');
    assert.equal(plain.roundTripByteExact, false,
      'the on-chain copy describes an older layout — this is the measured case');

    const union = await decodeUnionStoredAccount(dir, PROGRAM, vaultAccount.dataBase64);
    assert.equal(union.view.verdict, 'primary_only');
    assert.equal(union.view.arbitration.basis, 'secondary_refused');
    assert.equal(union.account, 'Vault');
    assert.equal(union.view.primary.decoded, true);
    assert.equal(union.view.secondary.decoded, false,
      'the published copy genuinely cannot identify these bytes');
    // The primary is the one that answered — same bytes as the plain path.
    assert.equal(union.roundTripByteExact, plain.roundTripByteExact);
    assert.equal(union.consumed, plain.consumed);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('R2: the refusal reason names the RENAME instead of a missing account', async () => {
  const dir = await store();
  try {
    const union = await decodeUnionStoredAccount(dir, PROGRAM, vaultAccount.dataBase64);
    const reason = union.view.secondary.refusedReason;
    assert.ok(reason, 'the secondary must still refuse');
    assert.match(reason, /no account type in this source matches the first 8 bytes/,
      'the measured fact (the discriminator does not match) stays in the reason');
    // The rename: both spellings, and the mechanism.
    assert.match(reason, /"vault"/, `the reason must name the copy's spelling: ${reason}`);
    assert.match(reason, /"Vault"/, `the reason must name the deployed spelling: ${reason}`);
    assert.match(reason, /derives an account discriminator from the exact name/,
      `the reason must explain WHY the copy cannot match: ${reason}`);
    assert.match(reason, /ded54f7cd8eeee83/,
      `the reason must quote the copy's derived discriminator: ${reason}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('R3: control — a source that does not declare the account keeps the generic reason', async () => {
  // Bytes whose discriminator neither copy of THIS program declares under any
  // spelling: no rename exists, so none may be reported. (An account of a
  // different program entirely — meteora-damm-v1's `Operator`, which the
  // meteora-vault copies know nothing about.)
  const dir = await store();
  try {
    const damm = await load('meteora-damm-v1-published-idl.json');
    const operatorDisc = damm.accounts.find((a) => a.name === 'Operator').discriminator;
    const foreign = Buffer.from([...operatorDisc, ...Buffer.alloc(64, 3)]);
    await assert.rejects(
      () => decodeUnionStoredAccount(dir, PROGRAM, foreign.toString('base64')),
      (error) => {
        assert.match(error.message, /both stored sources refuse/);
        assert.match(error.view.primary.refusedReason,
          /no account type in this source matches the first 8 bytes/);
        assert.match(error.view.secondary.refusedReason,
          /no account type in this source matches the first 8 bytes/);
        for (const reason of [error.view.primary.refusedReason, error.view.secondary.refusedReason]) {
          assert.ok(!/derives an account discriminator from the exact name/.test(reason),
            `no rename may be invented where none exists: ${reason}`);
        }
        return true;
      },
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('R4: the diagnosis is symmetric — a PRIMARY that cannot identify says the same', async () => {
  // Swap the roles: a copy that SPELLS the account differently and derives its
  // discriminator from that spelling (no stored value — the same shape as the
  // published meteora-vault copy) sits on the primary side, while the other
  // source pins a discriminator that matches the bytes. Same mechanism, other
  // direction: the refusal must be diagnosed as a rename too.
  const disc = [0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82]; // Config, meteora-damm-v1
  const bytes = Buffer.from([...disc, ...Buffer.alloc(96, 5)]);
  const declaringIdl = {
    instructions: [],
    accounts: [{ name: 'Config', discriminator: disc }],
    types: [{ name: 'Config', type: { kind: 'struct', fields: [{ name: 'v', type: 'u64' }] } }],
  };
  // The pull spells it `config` and stores NO discriminator, so Anchor derives
  // 71d0b66e5a2f6fd7 — which can never match bytes carrying 9b0caae0…
  const renamedPullIdl = {
    instructions: [],
    accounts: [{ name: 'config' }],
    types: [{ name: 'config', type: { kind: 'struct', fields: [{ name: 'v', type: 'u64' }] } }],
  };

  const union = unionAccountDecode({
    program: PROGRAM,
    primary: {
      label: 'metadata @slot 1', idl: renamedPullIdl,
      idlMeta: { fingerprint: 'sha256:primary', slot: 1, source: 'metadata' },
      objectPath: '/tmp/primary.json',
    },
    secondary: {
      label: 'published', idl: declaringIdl,
      idlMeta: { fingerprint: 'sha256:secondary', slot: null, source: 'published' },
      objectPath: '/tmp/secondary.json',
    },
    bytes,
  });

  // The secondary decodes, so the fallback question applies — and byte
  // evidence (a described round trip) admits it. The answer is the OTHER
  // copy's; the primary's refusal travels with it, diagnosed as a rename.
  assert.equal(union.view.verdict, 'fallback_secondary');
  assert.equal(union.view.arbitration.basis, 'primary_refused');
  assert.equal(union.view.primary.decoded, false);
  assert.equal(union.view.secondary.decoded, true);

  const reason = union.view.primary.refusedReason;
  assert.ok(reason, 'the primary refusal must be visible on the fallback answer');
  assert.match(reason, /"config"/, `the reason must name the pull's spelling: ${reason}`);
  assert.match(reason, /"Config"/, `the reason must name the other spelling: ${reason}`);
  assert.match(reason, /derives an account discriminator from the exact name/,
    `the reason must explain the mechanism: ${reason}`);
  assert.match(reason, /71d0b66e5a2f6fd7/,
    `the reason must quote the pull's derived discriminator: ${reason}`);
});
