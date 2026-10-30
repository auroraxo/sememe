// Read one stored IDL for a program, verified against its receipt.
//
// The store layout is the one produced by `sememe pull` / `sememe adopt`:
//   <store>/receipts/<program>-<slot>-<source>-<fingerprint>.json
//   <store>/objects/<fingerprint>.json
// The receipt binds the program id to the object, so decoding is offline and
// reproducible: same store + same payload => same result, no network call.
//
// The receipt is a claim; the recomputed hash is the check. Every step that can
// lie on the way to a decode is refused with a named reason instead of being
// tolerated:
//   - a receipt whose program field is not the program asked for (a receipt
//     swapped in from another program's file)
//   - a receipt pointing at an object that is not in the store
//   - an object that does not re-hash to the fingerprint the receipt claims
//     (the defect measured 2026-10-30: before this check, a tampered object —
//     valid JSON, one instruction renamed — was decoded happily and its
//     tampered name reported as provenance)
//   - an object declaring a different program than the receipt binds
// An unreadable or tampered store must never become another source's names.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './canonical.mjs';

export { canonicalJson } from './canonical.mjs';

/** Read and verify one receipt+object pair. Throws with a named reason. */
async function readVerified(storeDir, program, receiptName) {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(path.join(storeDir, 'receipts', receiptName), 'utf8'));
  } catch (error) {
    throw Error(`store receipt ${receiptName} is unreadable: ${String(error?.message ?? error).slice(0, 140)}`);
  }
  if (receipt?.program !== program) {
    throw Error(`store receipt ${receiptName} names program ${receipt?.program} — it is not a receipt for ${program}`);
  }
  const fingerprint = String(receipt.fingerprint).replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw Error(`store receipt has a malformed fingerprint: ${receipt.fingerprint}`);
  const objectPath = path.join(storeDir, 'objects', `${fingerprint}.json`);
  let raw;
  try { raw = await readFile(objectPath); }
  catch (error) {
    if (error?.code === 'ENOENT') {
      throw Error(`store receipt ${receiptName} claims object ${fingerprint} but the store object is missing`);
    }
    throw Error(`store object ${fingerprint}.json is unreadable: ${String(error?.message ?? error).slice(0, 140)}`);
  }
  let idl;
  try { idl = JSON.parse(raw); }
  catch (error) {
    throw Error(`store object ${fingerprint}.json is not JSON: ${String(error?.message ?? error).slice(0, 140)}`);
  }
  if (!Array.isArray(idl.instructions)) throw Error(`stored object for ${program} has no instructions`);
  if (idl.address && idl.address !== program) {
    throw Error(`stored object ${fingerprint} declares program ${idl.address}, not the receipt's ${program}`);
  }
  // `pull` writes sha256(canonicalJson(idl) + '\n'), so verify with the same
  // canonicalizer rather than with JSON.stringify, whose key order is not the
  // stored order. A receipt without this check is a filename, not provenance.
  const actual = createHash('sha256').update(`${canonicalJson(idl)}\n`).digest('hex');
  if (actual !== fingerprint) {
    throw Error(
      `stored object for ${program} re-hashes to sha256:${actual} but receipt ${receiptName} `
      + `claims sha256:${fingerprint}: object and receipt disagree, refusing to decode`,
    );
  }
  return { idl, receipt, receiptName, objectPath };
}

async function receiptNames(storeDir, program) {
  const receipts = path.join(storeDir, 'receipts');
  let names;
  try { names = await readdir(receipts); }
  catch (error) {
    if (error?.code === 'ENOENT') throw Error(`no sememe store at ${storeDir}: run "sememe pull" first`);
    throw error;
  }
  const candidates = names.filter((name) => name.startsWith(`${program}-`));
  if (!candidates.length) throw Error(`no stored IDL for program ${program} in ${storeDir}`);
  candidates.sort();
  return candidates;
}

/** Find the newest stored IDL for a program id, verified against its receipt. */
export async function findStoredIdl(storeDir, program) {
  const candidates = await receiptNames(storeDir, program);
  return readVerified(storeDir, program, candidates[candidates.length - 1]);
}

/**
 * Find the store's sources for a program, split by provenance.
 *
 * `primary` is the newest ON-CHAIN receipt (a real slot) and `secondary` is the
 * newest ADOPTED receipt (a published copy, slot null). The split is what keeps
 * the union honest: a published copy must never silently become the default
 * single source, and an on-chain pull must never be dropped because a file was
 * adopted later.
 *
 * Both are re-hashed against their receipts here; an unreadable or tampered
 * object is refused by name, never skipped silently.
 */
export async function findStoredIdls(storeDir, program) {
  const candidates = await receiptNames(storeDir, program);
  const onChain = [];
  const adopted = [];
  for (const name of candidates) {
    // The slot segment is the second field: `<program>-<slot>-<source>-<hash>`.
    const rest = name.slice(`${program}-`.length);
    const slotSegment = rest.split('-')[0];
    const source = await readVerified(storeDir, program, name);
    const entry = {
      // Human-readable provenance; the receipt filename stays in idlMeta.receipt.
      label: source.receipt.slot === null || source.receipt.slot === undefined
        ? `${source.receipt.source} (adopted, ${source.receipt.origin ?? source.receipt.fingerprint.slice(0, 12)})`
        : `${source.receipt.source} @slot ${source.receipt.slot}`,
      idl: source.idl,
      idlMeta: {
        fingerprint: source.receipt.fingerprint,
        slot: source.receipt.slot ?? null,
        source: source.receipt.source,
        origin: source.receipt.origin ?? null,
        receipt: source.receiptName,
      },
      objectPath: source.objectPath,
    };
    if (source.receipt.slot === null || source.receipt.slot === undefined) adopted.push(entry);
    else if (/^\d+$/.test(slotSegment)) onChain.push(entry);
    else adopted.push(entry);
  }
  onChain.sort((a, b) => (a.idlMeta.slot ?? 0) - (b.idlMeta.slot ?? 0));
  adopted.sort((a, b) => a.label.localeCompare(b.label));
  return {
    primary: onChain.length ? onChain[onChain.length - 1] : null,
    secondary: adopted.length ? adopted[adopted.length - 1] : null,
    onChain,
    adopted,
  };
}
