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
//   - a receipt whose DECLARED origin or body no longer matches its own
//     digest (src/receipt-digest.mjs): the fingerprint covers the OBJECT, so
//     before the receipt carried a digest, rewriting `origin` in the receipt
//     left `sememe verify` green over a rewritten provenance label — measured
//     2026-11-07: violations 0 after `origin` was changed to
//     `attacker/rewritten-origin`. A legacy receipt without digests is read as
//     it always was: its origin is then declared WITHOUT a binding.
// An unreadable or tampered store must never become another source's names.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './canonical.mjs';
import { compareReceiptNames } from './receipt-order.mjs';
import { classifyReceiptFiles, isReceiptFile } from './receipt-name.mjs';
import { receiptIntegrity } from './receipt-digest.mjs';
import { assertIdlShape, declaredProgram } from './dialect.mjs';

export { canonicalJson } from './canonical.mjs';

/** Read and verify one receipt+object pair. Throws with a named reason.
 *
 * Exported for `src/lock.mjs`: the lock must re-check every receipt through
 * THIS reader — a second, weaker copy of the checks would recreate the "one
 * store, two strengths" failure the header warns about. */
export async function readVerified(storeDir, program, receiptName) {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(path.join(storeDir, 'receipts', receiptName), 'utf8'));
  } catch (error) {
    throw Error(`store receipt ${receiptName} is unreadable: ${String(error?.message ?? error).slice(0, 140)}`);
  }
  if (receipt?.program !== program) {
    throw Error(`store receipt ${receiptName} names program ${receipt?.program} — it is not a receipt for ${program}`);
  }
  // The receipt's OWN integrity, before it is allowed to name anything. A
  // rewritten declared origin is refused HERE, on every read — decode, union
  // and verify all see the same refusal, and the reason says which kind of
  // rewrite happened (the lock reports the two differently).
  const integrity = receiptIntegrity(receipt);
  if (integrity) {
    const error = Error(`store receipt ${receiptName}: ${integrity.reason}`);
    error.code = integrity.code;
    throw error;
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
  // Same two checks as the write path (src/adopt.mjs), applied on every
  // read: a dialect the codec cannot read is refused by NAME before any
  // decode can crash unnamed, and a declared program that differs from the
  // receipt's program is a re-labelling no matter which field carries the
  // declaration (`address`, `metadata.address` or `program_id`).
  assertIdlShape(idl, (reason) => {
    const error = Error(`stored object ${fingerprint} for ${program}: ${reason}`);
    error.code = 'unsupported-idl-dialect';
    return error;
  });
  const declared = declaredProgram(idl);
  if (declared && declared !== program) {
    throw Error(`stored object ${fingerprint} declares program ${declared}, not the receipt's ${program}`);
  }
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
    if (error?.code === 'ENOENT') {
      // `code` names the KIND of failure so a caller can distinguish "this
      // store does not exist" from the absence of "this program is not in it"
      // WITHOUT parsing prose — src/conformance.mjs needs exactly that
      // (measured 2026-11-10: it swallowed both and reported a green gate).
      // The message is unchanged: it is quoted by bin/sememe.mjs, the README
      // and several tests.
      const missing = Error(`no sememe store at ${storeDir}: run "sememe pull" first`);
      missing.code = 'no-sememe-store';
      throw missing;
    }
    throw error;
  }
  const candidates = names.filter((name) => name.startsWith(`${program}-`) && isReceiptFile(name));
  if (!candidates.length) {
    // The store EXISTS and simply holds no receipt for this program: an
    // acquisition gap, never damage. Callers must be able to report it as
    // such instead of mistaking it for a reader refusal.
    const absent = Error(`no stored IDL for program ${program} in ${storeDir}`);
    absent.code = 'no-stored-idl';
    throw absent;
  }
  // Numeric slot order, NOT byte order: the slot in the filename is a decimal
  // NUMBER, and "99999999" sorts after "123456789" as a string — so a plain
  // sort picks the OLDER receipt as "last = newest" whenever two slot strings
  // differ in length (measured 2026-11-07: plain decode and lock said slot
  // 99999999, the union path — which sorts by numeric slot — said 123456789).
  // ONE ordering, shared with src/lock.mjs via src/receipt-order.mjs.
  candidates.sort(compareReceiptNames);
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
 * TWO RULES THAT MUST NOT DIVERGE (measured 2026-11-07, this host):
 *
 *   1. Adopted copies are ordered by the SHARED receipt ordering
 *      (src/receipt-order.mjs) — the exact rule `findStoredIdl` (the plain
 *      decode) and `src/lock.mjs` apply. They used to be ordered by their
 *      human-readable LABEL, which embeds the ORIGIN the caller typed: with
 *      two adopted copies the union path read the copy the origin spelling
 *      pointed at while the plain decode and the lock read the copy the
 *      fingerprint pointed at. Same store, same bytes, two answers —
 *      plain `decode` said `sell_v3`, `decode --union` refused the payload.
 *   2. When the store holds NO on-chain receipt and MULTIPLE adopted copies,
 *      the newest adopted copy is the `primary` and the next one the
 *      `secondary`, so the union path arbitrates the copies the store actually
 *      holds instead of consulting one and ignoring the rest. With exactly one
 *      adopted copy and no pull, `primary` stays null (the sole-source case):
 *      nothing on chain means there is no on-chain primary.
 *
 * Everything the pair does not consult is returned as `additional`, so the
 * caller can NAME it instead of pretending the store holds two sources.
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
      // An ADOPTED origin is DECLARED, never verified — the label says so, so no
      // reader can present a caller-typed string as a checked fact. A legacy
      // receipt without originStatus is declared too (adopt never verified it).
      label: source.receipt.slot === null || source.receipt.slot === undefined
        ? `${source.receipt.source} (adopted, declared origin: ${source.receipt.origin ?? source.receipt.fingerprint.slice(0, 12)})`
        : `${source.receipt.source} @slot ${source.receipt.slot}`,
      idl: source.idl,
      idlMeta: {
        fingerprint: source.receipt.fingerprint,
        slot: source.receipt.slot ?? null,
        source: source.receipt.source,
        origin: source.receipt.origin ?? null,
        originStatus: source.receipt.originStatus
          ?? (source.receipt.origin !== undefined && source.receipt.origin !== null ? 'declared' : null),
        receipt: source.receiptName,
      },
      objectPath: source.objectPath,
    };
    if (source.receipt.slot === null || source.receipt.slot === undefined) adopted.push(entry);
    else if (/^\d+$/.test(slotSegment)) onChain.push(entry);
    else adopted.push(entry);
  }
  // Ordered by the ONE shared rule (numeric slot, filename tiebreak) — the
  // same order `candidates` already arrives in from `receiptNames`, and the
  // same order `findStoredIdl` and src/lock.mjs apply. Never the label (it
  // carries the origin string the caller typed) and never the raw string (it
  // orders by digits, not by value).
  onChain.sort((a, b) => compareReceiptNames(a.idlMeta.receipt, b.idlMeta.receipt));
  // Adopted copies are ordered by the SAME shared rule — numeric slot first
  // (they all carry filename segment 0), then the filename byte-wise. Never
  // the label: it carries the origin string the caller typed, and two copies
  // of one program then answered from two different orderings.
  adopted.sort((a, b) => compareReceiptNames(a.idlMeta.receipt, b.idlMeta.receipt));

  let primary = onChain.length ? onChain[onChain.length - 1] : null;
  let secondary = adopted.length ? adopted[adopted.length - 1] : null;
  if (!primary && adopted.length >= 2) {
    // No pull in the store, but several verified published copies: they ARE the
    // union's two sources. Ranking them by the shared rule keeps the primary
    // equal to the copy `findStoredIdl` reads, so plain and union decode agree.
    primary = adopted[adopted.length - 1];
    secondary = adopted[adopted.length - 2];
  }
  const consulted = new Set([primary, secondary].filter(Boolean));
  const additional = [...onChain, ...adopted].filter((entry) => !consulted.has(entry));
  return {
    primary,
    secondary,
    additional,
    onChain,
    adopted,
  };
}
