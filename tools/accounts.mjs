// Decode a set of real mainnet accounts with the stored IDL.
//
//   node tools/accounts.mjs --accounts <harvest.json> --store <dir> --program <id>
//                           [--cross-check <idl.json>] [--out <file.json>]
//
// The account harvest file has the shape produced by the fetch recipe in
// research/account-harvest.md:
//   { program, harvestedAt, accounts: [{ address, dataBase64, ... }] }
//
// This is the account-side counterpart of tools/coverage.mjs. It answers, for
// real account bytes pulled from mainnet:
//   identified     the 8-byte discriminator names a type in the stored IDL
//   decoded        the IDL struct decoded it
//   byteExact      re-encoding the decoded struct reproduced the whole account
//   trailing       account bytes the IDL struct does not describe
//   refused        no account type matched / the struct could not decode
//
// `--cross-check <idl.json>` decodes the same bytes with the SAME code but a
// second, independently sourced IDL copy; any disagreement in the decoded
// values or in which account type matched is reported as a mismatch.

import { readFile, writeFile } from 'node:fs/promises';
import { withDerivedAccountDiscriminators, identifyAccount, decodeAccountData } from '../src/account.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};

const accountsPath = option('--accounts', null);
const storeDir = option('--store', null);
const program = option('--program', null);
const crossPath = option('--cross-check', null);
const outPath = option('--out', null);
if (!accountsPath || !storeDir || !program) {
  console.error('usage: node tools/accounts.mjs --accounts <file.json> --store <dir> --program <id> [--cross-check <idl.json>] [--out <file.json>]');
  process.exit(2);
}

const { findStoredIdl } = await import('../src/decode.mjs');
const stored = await findStoredIdl(storeDir, program);
const { idl, filled, conflicts } = withDerivedAccountDiscriminators(stored.idl);
const harvest = JSON.parse(await readFile(accountsPath, 'utf8'));
if (harvest.program !== program) {
  throw Error(`harvest is for ${harvest.program}, not ${program}`);
}
const crossIdl = crossPath ? JSON.parse(await readFile(crossPath, 'utf8')) : null;

const result = {
  program,
  harvestFile: accountsPath,
  harvestedAt: harvest.harvestedAt ?? null,
  idl: { fingerprint: stored.receipt.fingerprint, slot: stored.receipt.slot, source: stored.receipt.source },
  accountDiscriminators: { derived: filled, conflicts: conflicts.length, conflictList: conflicts },
  accounts: 0, identified: 0, decoded: 0, byteExact: 0, trailing: 0, trailingBytes: 0,
  refusals: [], byType: {}, crossCheck: crossIdl ? { compared: 0, disagreements: [] } : null,
};

for (const account of harvest.accounts ?? []) {
  const bytes = Buffer.from(account.dataBase64, 'base64');
  result.accounts++;
  const identified = identifyAccount(idl, bytes);
  if (!identified) {
    result.refusals.push({ address: account.address, reason: 'no account discriminator match', length: bytes.length });
    continue;
  }
  result.identified++;
  let decoded;
  try {
    decoded = decodeAccountData(idl, bytes, identified.name, { trailing: 'report' });
  } catch (error) {
    result.refusals.push({ address: account.address, account: identified.name, reason: String(error.message).slice(0, 200) });
    continue;
  }
  result.decoded++;
  const stats = (result.byType[identified.name] ??= { n: 0, byteExact: 0, trailing: 0 });
  stats.n++;
  if (decoded.roundTripByteExact) { result.byteExact++; stats.byteExact++; }
  else if (decoded.trailing.count > 0) {
    result.trailing++; stats.trailing++;
    result.trailingBytes += decoded.trailing.count;
  }
  if (crossIdl) {
    try {
      const other = withDerivedAccountDiscriminators(crossIdl);
      const otherId = identifyAccount(other.idl, bytes);
      const mine = JSON.stringify(decoded.args);
      const theirs = otherId
        ? JSON.stringify(decodeAccountData(other.idl, bytes, otherId.name, { trailing: 'report' }).args)
        : null;
      if (!otherId || otherId.name !== identified.name || mine !== theirs) {
        result.crossCheck.disagreements.push({
          address: account.address, account: identified.name,
          crossAccount: otherId ? otherId.name : null,
        });
      } else result.crossCheck.compared++;
    } catch (error) {
      result.crossCheck.disagreements.push({
        address: account.address, account: identified.name,
        error: String(error.message).slice(0, 160),
      });
    }
  }
}

console.log(JSON.stringify(result, null, 1));
if (outPath) await writeFile(outPath, JSON.stringify(result, null, 1) + '\n');
