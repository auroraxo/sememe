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

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

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
  if (idl.address !== undefined) {
    if (typeof idl.address !== 'string') throw Error(`${filePath} declares a malformed address field`);
    if (idl.address !== program) {
      throw Error(`${filePath} declares program ${idl.address}, not ${program} — refusing to re-label a foreign interface`);
    }
  }

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
    // null, not 0: this receipt did not come from a slot. The filename uses 0
    // purely so it sorts before every real slot in findStoredIdl's selection.
    slot: null,
    fingerprint: `sha256:${fingerprint}`,
    instructionCount: idl.instructions.length,
  };
  const receiptPath = path.join(receipts, `${program}-0-${sourceLabel}-${fingerprint}.json`);
  await writeOnce(receiptPath, Buffer.from(canonicalJson(receipt) + '\n'));
  return { ...receipt, path: path.join(objects, `${fingerprint}.json`), receiptPath };
}
