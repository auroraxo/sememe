// Account decoding: the other half of the interface.
//
// Instructions are what a program DOES; accounts are what it KNOWS. Every
// proof in this repository until 29.10. ended with "accounts are still
// undecoded". This test measures account decoding against real mainnet
// account bytes from three programs:
//
//   Whirlpool  (new-format IDL, stored account discriminators)
//   OpenBook v2 (legacy IDL, ZERO stored discriminators -> derived)
//   Kamino Lend (legacy IDL, ZERO stored discriminators -> derived)
//
// Two independent oracles pin the values:
//   - account-discriminators-anchor-ts.json: anchor-ts's OWN computation of
//     sha256("account:" + name) for all 29 account names across 4 IDLs.
//   - account-values-golden-2026-10-29.json: sha256 of the canonical JSON of
//     anchor-ts's own decode of each pinned mainnet account, normalised to
//     sememe's JSON shape. The hash is checked in CI, so a value regression
//     fails even though anchor-ts is not installed there.
//
// The strongest claim here is byte-exactness: re-encoding the decoded struct
// must reproduce the account bytes on chain. A wrong field order, a wrong
// width, or a missed field breaks that even if the values "look right".

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  accountDiscriminator, withDerivedAccountDiscriminators, identifyAccount, decodeAccountData,
} from '../src/account.mjs';

const PROGRAMS = [
  {
    id: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    idl: 'whirlpool-idl.json',
    accounts: 'accounts-whirlpool-2026-10-29.json',
    storedDiscriminators: true,
  },
  {
    id: 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb',
    idl: 'openbook-v2-idl.json',
    accounts: 'accounts-openbook-v2-2026-10-29.json',
    storedDiscriminators: false,
  },
  {
    id: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
    idl: 'kamino-lend-idl.json',
    accounts: 'accounts-kamino-lend-2026-10-29.json',
    storedDiscriminators: false,
  },
];

const load = async (name) => JSON.parse(
  await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const anchorDiscriminators = await load('account-discriminators-anchor-ts.json');
const golden = await load('account-values-golden-2026-10-29.json');
const foreignFixture = await load('accounts-openbook-v2-2026-10-29.json');

function blobs(fixture) {
  return fixture.accounts.map((account) => ({
    address: account.address,
    data: Buffer.from(account.dataBase64, 'base64'),
  }));
}

test('the account discriminator rule matches anchor-ts, byte for byte, for all 29 names', () => {
  let checked = 0;
  for (const [program, expected] of Object.entries(anchorDiscriminators.programs)) {
    assert.ok(Object.keys(expected).length > 0, program);
    for (const [name, hex] of Object.entries(expected)) {
      const mine = Buffer.from(accountDiscriminator(name)).toString('hex');
      assert.equal(mine, hex, `${program} account ${name}`);
      checked++;
    }
  }
  assert.equal(checked, 29);
});

for (const program of PROGRAMS) {
  const idl = await load(program.idl);
  const fixture = await load(program.accounts);
  const { idl: filled, filled: derived, conflicts } = withDerivedAccountDiscriminators(idl);
  const accountBlobs = blobs(fixture);

  test(`${program.id}: the account fixture is the program it claims`, () => {
    assert.equal(fixture.program, program.id);
    assert.ok(accountBlobs.length >= 4, `only ${accountBlobs.length} pinned accounts`);
    assert.ok(accountBlobs.every((entry) => entry.data.length > 8));
  });

  test(`${program.id}: account discriminators are stored=${program.storedDiscriminators}, derived gaps filled, no conflicts`, () => {
    assert.equal(conflicts.length, 0, JSON.stringify(conflicts));
    assert.equal(derived, program.storedDiscriminators ? 0 : idl.accounts.length);
    // Every stored discriminator must equal the Anchor rule too.
    for (const account of filled.accounts) {
      const derivedHex = Buffer.from(accountDiscriminator(account.name)).toString('hex');
      assert.equal(Buffer.from(account.discriminator).toString('hex'), derivedHex, account.name);
    }
  });

  test(`${program.id}: every real mainnet account identifies, decodes and re-encodes byte-exact`, () => {
    let identified = 0, decoded = 0, byteExact = 0;
    for (const entry of accountBlobs) {
      const id = identifyAccount(filled, entry.data);
      if (!id) continue;
      identified++;
      const result = decodeAccountData(filled, entry.data, id.name);
      decoded++;
      assert.equal(result.trailing.count, 0,
        `${id.name}: ${result.trailing.count} byte(s) the IDL does not describe`);
      if (result.roundTripByteExact) byteExact++;
    }
    assert.equal(identified, accountBlobs.length, 'some account bytes have no matching discriminator');
    assert.equal(decoded, accountBlobs.length);
    assert.equal(byteExact, accountBlobs.length,
      're-encoding did not reproduce the account bytes');
  });

  test(`${program.id}: decoded values match the anchor-ts golden`, () => {
    const expected = golden.programs[program.id];
    assert.ok(expected, 'no golden for this program');
    let checked = 0;
    for (const entry of accountBlobs) {
      const want = expected[entry.address];
      if (!want) continue;
      const id = identifyAccount(filled, entry.data);
      assert.ok(id, `golden account ${entry.address} did not identify`);
      assert.equal(id.name, want.account, entry.address);
      const result = decodeAccountData(filled, entry.data, id.name);
      const hash = createHash('sha256').update(JSON.stringify(result.args)).digest('hex');
      assert.equal(hash, want.valueSha256, `value drift for ${want.account} at ${entry.address}`);
      checked++;
    }
    assert.ok(checked >= 4, `only ${checked} golden accounts checked`);
  });

  if (!program.storedDiscriminators) {
    test(`${program.id}: without derivation NOTHING identifies — the derivation is load-bearing`, () => {
      // Same falsification as the instruction side: build the index from the
      // published bytes alone. A legacy IDL stores no account discriminator,
      // so the index is empty and every real account is refused.
      let identified = 0;
      for (const entry of accountBlobs) {
        if (identifyAccount(idl, entry.data)) identified++;
      }
      assert.equal(identified, 0);
    });
  }

  test(`${program.id}: the byte-exactness metric is falsifiable — a wrong layout cannot pass`, () => {
    // Falsify the check itself. If a corrupted layout still produced
    // "decoded + trailing 0 + byte-exact", the assertions above would prove
    // nothing about the struct being right.
    const entry = accountBlobs.find((candidate) => {
      const id = identifyAccount(filled, candidate.data);
      if (!id) return false;
      try {
        const r = decodeAccountData(filled, candidate.data, id.name, { trailing: 'error' });
        return r.consumed === r.total;
      } catch { return false; }
    });
    assert.ok(entry, 'no fully-described account to corrupt');
    const id = identifyAccount(filled, entry.data);

    // (a) Corrupt the discriminator: identification must refuse the bytes.
    const tampered = Buffer.from(entry.data);
    tampered[0] ^= 0x01;
    assert.equal(identifyAccount(filled, tampered), null,
      'a foreign discriminator still matched an account type');

    // (b) Corrupt the layout: drop the struct's first field. Decode must then
    // refuse (bytes left over under trailing:error) or fail byte-exactness —
    // never pass all three gates at once.
    const broken = structuredClone(filled);
    const brokenAccount = broken.accounts.find((account) => account.name === id.name);
    const struct = brokenAccount.type ?? broken.types.find((t) => t.name === id.name).type;
    assert.ok(struct.fields.length > 1, 'struct has no field to drop');
    const dropped = struct.fields.shift();
    assert.ok(dropped && dropped.name, 'no field dropped');

    let passedAllGates = false;
    try {
      const result = decodeAccountData(broken, entry.data, id.name, { trailing: 'error' });
      passedAllGates = result.consumed === result.total && result.trailing.count === 0
        && result.roundTripByteExact;
    } catch {
      passedAllGates = false; // refusal is the correct outcome
    }
    assert.equal(passedAllGates, false,
      'a layout missing a field still decoded, described and reproduced the account');
  });

  test(`${program.id}: foreign program bytes identify as nothing`, () => {
    // Another program's account must not be readable with this IDL: the
    // discriminator table is what stops "any struct fits any bytes".
    const foreign = foreignFixture;
    if (foreign.program === program.id) return;
    for (const entry of blobs(foreign)) {
      assert.equal(identifyAccount(filled, entry.data), null,
        `${foreign.program} bytes matched a ${program.id} account type`);
    }
  });
}
