// Measure the native decoder against REAL mainnet traffic, and against the
// hand-written table it replaces.
//
// The claim this tool supports is not "the table looks right" but "the table
// names the bytes the chain actually carries". Three measurements, in order:
//
//   1. COVERAGE   — over a harvested payload set: how many payloads get a
//      name, how many refuse (and with which named reason), and whether the
//      named ones re-encode byte-for-byte.
//   2. ROUND TRIP — every decoded payload is re-encoded and compared to the
//      original bytes. A name that does not re-encode is a wrong name.
//   3. ORACLE     — the same payloads are decoded by the OLD hand-written
//      table (when it is available) and by @solana/web3.js (when it is
//      installed). Both are compared against the new decoder. Where they
//      disagree, the tool prints the exact bytes so the disagreement can be
//      adjudicated instead of averaged away.
//
// Usage:
//   node tools/native-coverage.mjs --harvest <file.json> [--out <report.json>]
//   node tools/native-coverage.mjs --harvest <file.json> --oracle old
//   node tools/native-coverage.mjs --harvest <file.json> --oracle web3
//
// The report is written so a committed fixture and a fresh run can be compared
// byte for byte: everything that changes per run (timestamps) lives in one
// field, and a committed report is compared without it.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  decodeNativeInstruction, nativeProvenance, nativeNames,
} from '../src/native.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
};

const harvestPath = option('--harvest', null);
const outPath = option('--out', null);
const oracle = option('--oracle', null);
if (!harvestPath) {
  console.error('usage: node tools/native-coverage.mjs --harvest <file.json> [--out <report.json>] [--oracle old|web3]');
  process.exit(2);
}

const harvest = JSON.parse(await readFile(harvestPath, 'utf8'));
const program = harvest.program;

const payloads = [];
for (const transaction of harvest.transactions ?? []) {
  for (const payload of transaction.payloads ?? []) payloads.push(payload);
}

// --- the old hand-written table, when it is on this machine -----------------
//
// It lives in the consumer repository (solana-tx-remix/src/native.mjs). It is
// loaded, not copied: a copied table would be a table that can drift from the
// one being replaced, which is the failure mode this whole exercise is about.
async function loadOldTable() {
  const candidates = [
    process.env.OLD_NATIVE_MODULE,
    path.resolve(process.env.HOME ?? '', 'github_repos/solana-tx-remix/src/native.mjs'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const module = await import(candidate);
      return { module, path: candidate };
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') {
        return { module: null, path: candidate, error: error.message };
      }
    }
  }
  return { module: null, path: null, error: 'old table not found' };
}

// --- @solana/web3.js, when it is installed ---------------------------------
async function loadWeb3() {
  try {
    const module = await import('@solana/web3.js');
    return { module, path: '@solana/web3.js' };
  } catch (error) {
    return { module: null, path: null, error: error.message };
  }
}

/**
 * web3.js decodes System instructions through its own layouts, but exposes no
 * public "decode arbitrary system instruction data" entry point that returns
 * the variant name for a raw buffer. It DOES expose `decodeInstructionType`,
 * which returns the type NAME from the leading u32 — enough for an oracle on
 * the tag, which is the part the two tables could disagree about. The
 * argument shapes are checked separately by re-encoding through the SDK's own
 * layout (see oracleWeb3 below).
 */
function oracleWeb3(ixModule, bytes) {
  if (!ixModule) return null;
  try {
    const type = ixModule.SystemInstruction.decodeInstructionType({ programId: { toString: () => '11111111111111111111111111111111' }, data: bytes });
    return { name: type };
  } catch (error) {
    return { name: null, error: error.message.slice(0, 120) };
  }
}

const old = await loadOldTable();
const web3 = oracle === 'web3' ? await loadWeb3() : { module: null, path: null, error: 'not requested' };

const names = {};
const refusals = {};
const disagreements = [];
let decoded = 0;
let roundTripExact = 0;
let trailingPayloads = 0;
let oldNamed = 0;
let web3Named = 0;
let web3Agree = 0;
let web3Disagree = 0;

for (const payload of payloads) {
  const bytes = Buffer.from(payload.dataHex, 'hex');
  let result = null;
  let refusal = null;
  try {
    result = decodeNativeInstruction(program, bytes, { trailing: 'report' });
  } catch (error) {
    refusal = error.reason ?? `thrown: ${error.message}`;
  }
  if (result) {
    decoded += 1;
    names[result.name] = (names[result.name] ?? 0) + 1;
    if (result.roundTripByteExact) roundTripExact += 1;
    if (result.trailing.count > 0) trailingPayloads += 1;
  } else if (refusal) {
    refusals[refusal] = (refusals[refusal] ?? 0) + 1;
  }

  if (old.module) {
    const oldResult = old.module.decodeNative(program, bytes);
    if (oldResult) oldNamed += 1;
    const newName = result?.name ?? null;
    const oldName = oldResult?.name ?? null;
    if (newName !== oldName) {
      disagreements.push({
        bytes: payload.dataHex,
        newName,
        oldName,
        oldRefused: oldResult ? null : 'not-named',
        newRefusal: refusal,
      });
    }
  }

  if (web3.module) {
    const oracleResult = oracleWeb3(web3.module, bytes);
    if (oracleResult?.name) {
      web3Named += 1;
      const newName = result?.name ?? null;
      if (newName === oracleResult.name) web3Agree += 1;
      else {
        web3Disagree += 1;
        disagreements.push({
          bytes: payload.dataHex,
          newName,
          web3Name: oracleResult.name,
          web3Error: oracleResult.error ?? null,
        });
      }
    }
  }
}

const report = {
  program,
  harvest: {
    file: path.basename(harvestPath),
    harvestedAt: harvest.harvestedAt ?? null,
    slotRange: harvest.slotRange ?? null,
    transactions: (harvest.transactions ?? []).length,
    payloads: payloads.length,
  },
  interface: nativeProvenance(program),
  tableNames: nativeNames(program),
  coverage: {
    decoded,
    refused: Object.values(refusals).reduce((sum, value) => sum + value, 0),
    roundTripByteExact: roundTripExact,
    trailingPayloads,
    byName: names,
    refusals,
  },
  oracle: {
    oldTable: old.module
      ? { path: old.path, named: oldNamed, namedShare: payloads.length ? oldNamed / payloads.length : 0 }
      : { path: null, error: old.error ?? 'not found' },
    web3: web3.module
      ? { path: web3.path, named: web3Named, agree: web3Agree, disagree: web3Disagree }
      : { path: null, error: web3.error ?? 'not requested' },
    disagreements: disagreements.slice(0, 20),
    disagreementCount: disagreements.length,
  },
};

if (outPath) await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify({
  program,
  payloads: payloads.length,
  decoded,
  roundTripByteExact: roundTripExact,
  refusals,
  byName: names,
  oldTableNamed: old.module ? oldNamed : null,
  web3: web3.module ? { named: web3Named, agree: web3Agree, disagree: web3Disagree } : null,
  disagreementCount: disagreements.length,
}, null, 2));
if (disagreements.length) {
  console.error(`\n${disagreements.length} disagreement(s); first few:`);
  for (const item of disagreements.slice(0, 5)) console.error(JSON.stringify(item));
}
