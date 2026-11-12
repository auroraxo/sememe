// `sememe adopt <program> <file>` — put a first-party PUBLISHED interface copy
// into the store so union decode has a second verified source to read.
//
// What adopt does and does not claim. `pull` gets its authority from the chain:
// the account is fetched at a finalized slot and bound to the program id.
// `adopt` gets its authority from a FILE the caller names: it is content-
// addressed and fingerprinted exactly like a pull, and every reader re-hashes
// it — but its receipt says `source: published` and carries the origin the
// caller declared. It is provenance of BYTES, not proof the bytes describe the
// deployed program. That distinction is why the two receipts stay separate and
// why union decode must keep naming which source answered.
//
// The ORIGIN is a DECLARED label and sememe says so on every surface
// (`originStatus: 'declared'`, the reader label, the CLI note): nothing checks
// that the named repository, commit or file exists. Measured 2026-11-07 (this
// host, published v0.4.10): a caller could name a repository that does not
// exist and every reader would repeat it as the origin, and `sememe verify`
// stayed green after the origin was rewritten in the receipt — because the
// fingerprint covers the OBJECT and the label next to it was covered by
// nothing. The receipt now carries `originDigest` (binds the declared label)
// and `receiptDigest` (binds the whole receipt body), see
// src/receipt-digest.mjs; readers refuse a receipt whose digest disagrees.
// The origin is still NOT verified — it is bound, so it cannot change
// silently. Checked provenance remains first-party adoption with a recorded
// commit and the on-chain pull, which needs no label at all.
//
// Why slot 0 in the receipt filename: receipts sort as
// `<program>-<slot>-<source>-<fingerprint>.json` and `findStoredIdl` picks the
// last name. Adopted copies must NEVER win the default single-source selection
// over an on-chain receipt — otherwise adopting a published copy would silently
// switch what plain `sememe decode` reads (measured hazard: pump's published
// copy disagrees with its on-chain account on 4 shared instructions). The
// receipt carries `slot: null` to say the truth about where it did NOT come
// from; the filename segment only orders it before every real slot.

import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './canonical.mjs';
import { writeOnce } from './store-write.mjs';
import { originDigestOf, receiptDigestOf } from './receipt-digest.mjs';
import { assertIdlShape, declaredProgram } from './dialect.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** What `sememe adopt` prints about the origin it recorded. It lives in the
 * receipt body for new receipts and in the CLI output always. */
export const ORIGIN_NOTE = 'declared origin, not verified: sememe did not check that this repository, commit or file exists, and the bytes were not proven to come from it — provenance of bytes, not proof they describe the deployed program';

/** Fields that identify WHICH object a receipt points at. Two receipts of one
 * filename that agree on these make the same claim; only a differing declared
 * origin makes them two claims about one set of bytes. */
const IDENTITY_FIELDS = ['program', 'source', 'slot', 'fingerprint', 'instructionCount'];

const safeLabel = (value, what) => {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${what} must be a non-empty string`);
  const cleaned = value.trim().replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 64);
  if (!/^[A-Za-z0-9._:-]+$/.test(cleaned)) throw Error(`${what} is not usable in a receipt filename: ${JSON.stringify(value)}`);
  return cleaned;
};

/**
 * Store a published IDL file under a content-addressed object plus a receipt.
 *
 * Validation mirrors what `pull` enforces on fetched content: JSON, an
 * instructions array, and — when the file declares an address — agreement with
 * the program the receipt binds. A file that declares a DIFFERENT program is
 * refused rather than re-labelled.
 *
 * Returns the receipt (same shape family as `pull`, plus `origin`).
 */
export async function adopt(programInput, filePath, storeDir, { source = 'published', origin } = {}) {
  if (typeof programInput !== 'string' || !programInput.trim()) throw Error('program id required');
  const program = programInput.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(program)) throw Error('program id must be base58');
  if (typeof storeDir !== 'string' || !storeDir.trim()) throw Error('explicit --store path required');
  const sourceLabel = safeLabel(source, '--source');
  const originLabel = safeLabel(origin ?? path.basename(filePath), '--origin');

  let idl;
  let raw;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    throw Error(`cannot read ${filePath}: ${String(error?.message ?? error).slice(0, 140)}`);
  }
  try {
    idl = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw Error(`${filePath} is not JSON: ${String(error?.message ?? error).slice(0, 140)}`);
  }
  if (!idl || typeof idl !== 'object' || Array.isArray(idl)) throw Error(`${filePath} is not an IDL object`);
  if (!Array.isArray(idl.instructions)) throw Error(`${filePath} has no instructions array — not an interface copy`);
  // Two INDEPENDENT gates, each with its own named voice, checked in the
  // order the faces were measured — an integrity question first (does this
  // file claim to be about THIS program?), a capability question second
  // (can the codec read this dialect at all?). Collapsing them would hide
  // one face behind the other.
  //
  // Gate 1 — declared-program agreement. A file may declare its program
  // under `address` (Anchor), `metadata.address` (shank) or `program_id`
  // (raw dialects). Whatever the field is called, a DECLARED program that
  // differs from the receipt's program is a re-labelling: measured
  // 2026-11-12, the diabloarb file declares `program_id` only, and the old
  // address-only check adopted it under WSOL's program id unchanged.
  if (idl.address !== undefined && typeof idl.address !== 'string') {
    throw Error(`${filePath} declares a malformed address field`);
  }
  const declared = declaredProgram(idl);
  if (declared && declared !== program) {
    if (idl.address === undefined) {
      // The declaration rides a field the old check never read — name the
      // field so the repair is obvious (this is the measured diabloarb face).
      const field = idl.program_id !== undefined ? 'program_id'
        : idl?.metadata?.address !== undefined ? 'metadata.address' : 'declared program';
      throw Error(`${filePath} declares program ${declared} via ${field}, not ${program} — refusing to re-label a foreign interface`);
    }
    throw Error(`${filePath} declares program ${declared}, not ${program} — refusing to re-label a foreign interface`);
  }
  // Gate 2 — the dialect gate runs at the store's WRITE path too: an
  // interface the codec cannot read (measured 2026-11-12: diabloarb's
  // tag/data dispatch with dict `types`) is refused HERE, not after
  // adoption when every decode crashes unnamed. Same reason text as the
  // codec's guard (src/dialect.mjs).
  assertIdlShape(idl, (reason) => Error(`${filePath}: ${reason}`));

  const json = Buffer.from(canonicalJson(idl) + '\n');
  const fingerprint = sha256(json);
  const directory = path.resolve(storeDir);
  const objects = path.join(directory, 'objects');
  const receipts = path.join(directory, 'receipts');
  await mkdir(objects, { recursive: true, mode: 0o700 });
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  await writeOnce(path.join(objects, `${fingerprint}.json`), json);

  const receipt = {
    program,
    source: sourceLabel,
    origin: originLabel,
    originStatus: 'declared',
    originNote: ORIGIN_NOTE,
    originDigest: originDigestOf(originLabel),
    // null, not 0: this receipt did not come from a slot. The filename uses 0
    // purely so it sorts before every real slot in findStoredIdl's selection.
    slot: null,
    fingerprint: `sha256:${fingerprint}`,
    instructionCount: idl.instructions.length,
  };
  // The digest covers the whole body INCLUDING the declared label — a receipt
  // that is edited afterwards fails this check on every read, not only under
  // a lock.
  receipt.receiptDigest = receiptDigestOf(receipt);
  const bytes = Buffer.from(canonicalJson(receipt) + '\n');

  const plainPath = path.join(receipts, `${program}-0-${sourceLabel}-${fingerprint}.json`);
  let receiptPath = plainPath;
  const existing = await readReceiptIfPresent(plainPath);
  if (existing) {
    const sameClaim = IDENTITY_FIELDS
      .every((field) => (existing[field] ?? null) === (receipt[field] ?? null));
    if (sameClaim && existing.origin === receipt.origin) {
      // Re-adopting the SAME bytes under the SAME declared origin changes
      // nothing — including a legacy body written before the digest fields
      // existed: an old receipt is never rewritten in place, its origin is
      // then merely DECLARED without a binding.
      return {
        ...existing,
        originStatus: existing.originStatus ?? 'declared',
        originNote: ORIGIN_NOTE,
        path: path.join(objects, `${fingerprint}.json`),
        receiptPath: plainPath,
      };
    }
    if (!sameClaim) {
      // The filename already names program/source/fingerprint, so a receipt
      // that disagrees on these is not adopt's doing — refuse instead of
      // layering a second claim over a file that means something else.
      throw Error(`receipt ${plainPath} exists with different content for the same program, source and fingerprint — refusing to store this interface copy`);
    }
    // The SAME bytes under a DIFFERENT declared origin: two claims about one
    // object, so two receipts. The disambiguator is a digest of the declared
    // origin (12 hex chars), placed BEFORE the fingerprint so the filename
    // keeps its `<program>-<slot>-<source>-<fingerprint>` tail that readers
    // and tools parse the object id out of. The caller's TEXT never enters
    // the filename, and both receipts carry the same fingerprint, so which of
    // them sorts last cannot change a decoded byte — only which declared
    // label is shown first.
    const originKey = originDigestOf(originLabel).slice(7, 19);
    receiptPath = path.join(receipts, `${program}-0-${sourceLabel}-${originKey}-${fingerprint}.json`);
  }
  await writeOnce(receiptPath, bytes);
  return { ...receipt, path: path.join(objects, `${fingerprint}.json`), receiptPath };
}

async function readReceiptIfPresent(receiptPath) {
  try {
    return JSON.parse(await readFile(receiptPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw Error(`receipt ${receiptPath} is not JSON — refusing to build a second claim over it`);
    }
    throw error;
  }
}
