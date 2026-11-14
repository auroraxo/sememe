// The HADRo acquisition: a pinned, hash-verified first-party published IDL for
// the ONE program sememe can decode but NOT fully re-encode from the on-chain
// copy (measured 2026-11-14, HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8,
// research/hadron-adoption-2026-11-14.json).
//
// THE MEASURED GAP (this is the reason the file exists, not a preference):
//
// The on-chain metadata IDL (pulled at slot 468262003) is COMPLETE on
// instructions and types, but it is missing exactly two argument declarations
// — `sequence: u64` as the last argument of setCurve and setRiskCurve. The
// wire carries those 8 bytes after the points, so with the stored copy alone:
//
//   144/144 committed chain-accepted payloads decode        (0 refused)
//   144/144 end with 8 UNEXPLAINED trailing bytes
//     0/144 round-trip byte-exact                          (the tail is dropped)
//   144/144 are REFUSED by --trailing error
//
// A user who wants byte-exactness has no fix available on that path: the bytes
// are real, the IDL simply does not declare them. `sememe adopt-hadron` puts
// the first-party published copy (Hadron-Fi/hadron-tx-verifier, which declares
// the two `sequence: u64` tails) into the store beside the on-chain receipt, so
// `sememe decode --union` arbitrates BY BYTES: the published copy then
// reproduces 144/144 payloads byte-exact with 0 trailing bytes, and the drift
// against the on-chain copy is reported by NAME (paths: ["sequence"]) instead
// of silently choosing one source.
//
// WHAT THE PIN DOES NOT CLAIM (src/adopt.mjs says this on every surface): the
// receipt's origin stays `declared` — the vendored bytes are bound to a commit
// by sha256, but a commit is content-addressed, not signed, and nothing here
// proves the bytes describe the DEPLOYED program. Chain proof stays with the
// decode: every payload must re-encode byte-exactly or union refuses.
//
// WHAT SHIPPING THE COPY DOES NOT CHANGE: plain `sememe decode` still reads
// the on-chain receipt (slot 0 sorts before every real slot — the rule
// src/adopt.mjs measures and pins). Adoption widens what `--union` can
// arbitrate; it never silently rewrites the default single-source answer.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

export const HADRON_PROGRAM = 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8';

export const HADRON_PIN = {
  repo: 'Hadron-Fi/hadron-tx-verifier',
  commit: '0c1bca1d8c9bc2abaa1b3d651d450c814cdd6328',
  // Dual-licensed: the repo carries LICENSE-APACHE + LICENSE-MIT + NOTICE, all
  // three vendored beside the IDL so a redistributor of the npm tarball has
  // the terms and the attribution NOTICE in the same directory as the bytes.
  license: 'Apache-2.0 AND MIT',
  // sha256 of the bytes AS PUBLISHED at that commit, read via the GitHub
  // contents API with `?ref=<commit>` — not from a mutable working tree.
  files: [
    {
      file: 'idl/hadron.json',
      role: 'first-party published IDL: the copy that declares the two sequence:u64 tails the on-chain metadata IDL lacks',
      sha256: '219f44fb63729232b3685fbde49a817b0c8321a0203dcca68c88370fbed1279e',
    },
    {
      file: 'LICENSE-APACHE',
      role: 'Apache-2.0 terms the vendored copy ships under',
      sha256: 'e4cbaf2699b8d6509727edfae292eabe12249f8a31d4dc978de59e15d12ec717',
    },
    {
      file: 'LICENSE-MIT',
      role: 'MIT terms the vendored copy ships under',
      sha256: '81382b018e2877fc1f037cc427ecb62333e653ddd05e6e1ff141b184735c7d92',
    },
    {
      file: 'NOTICE',
      role: 'attribution NOTICE (fork of multisig-verifier, Squads Labs; Hadron modifications)',
      sha256: 'e39dc25965a71c43d8e475edf3b123f6028239ba612026065d43a5f124dfc36f',
    },
  ],
  // The FULL provenance string, as documentation. It is 96 characters, so
  // `sememe adopt`'s own label sanitizer would TRUNCATE it to 64 (that is
  // where the existing lighthouse origin loses its commit tail and its file
  // path — a pre-existing shape this module does not copy). The label
  // actually recorded is hadronOriginLabel() below, which FITS in 64 and
  // therefore loses nothing.
  origin: 'github.com/Hadron-Fi/hadron-tx-verifier@0c1bca1d8c9bc2abaa1b3d651d450c814cdd6328:idl/hadron.json',
};

/** The two arguments this acquisition exists to supply. They are the entire
 * difference between an IDL that reports the wire's 8-byte tail as unexplained
 * bytes and one that names it — measured, see research/hadron-adoption-*.json. */
export const HADRON_MISSING_ARGS = [
  { instruction: 'setCurve', arg: 'sequence', type: 'u64' },
  { instruction: 'setRiskCurve', arg: 'sequence', type: 'u64' },
];

export function vendoredHadronPath(file, root = REPO_ROOT) {
  return path.join(root, 'vendor', 'hadron', HADRON_PIN.commit, path.basename(file));
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export class HadronPinError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'HadronPinError';
    this.reason = reason;
  }
}

/**
 * Read the vendored IDL and verify it against the pin. Every refusal is NAMED
 * so a caller can tally failure faces without parsing prose.
 *
 * Returns { idl, path, sha256, bytes, declaredMissing } on success, where
 * `declaredMissing` is the list of HADRON_MISSING_ARGS entries this copy
 * actually declares — the measured reason for adopting it.
 */
export function loadVendoredHadron(root = REPO_ROOT, pin = HADRON_PIN) {
  const pinned = pin.files.find((f) => f.file.endsWith('hadron.json'));
  const vendoredPath = path.join(root, 'vendor', 'hadron', pin.commit, path.basename(pinned.file));
  let raw;
  try {
    raw = readFileSync(vendoredPath);
  } catch (error) {
    throw new HadronPinError(
      'hadron-vendor-missing',
      `${vendoredPath} is not present (${error.code ?? error.message})`,
    );
  }
  const now = createHash('sha256').update(raw).digest('hex');
  if (now !== pinned.sha256) {
    throw new HadronPinError(
      'hadron-vendor-hash-mismatch',
      `pinned ${pinned.sha256}, hashed now ${now} — refusing to adopt bytes that are not the reviewed copy`,
    );
  }
  let idl;
  try {
    idl = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new HadronPinError('hadron-vendor-unparseable', String(error.message ?? error));
  }
  if (!idl || typeof idl !== 'object' || Array.isArray(idl)) {
    throw new HadronPinError('hadron-vendor-unparseable', 'not an IDL object');
  }
  // Address binding: this file claims HADRo by its own `address`, the same
  // field the on-chain receipt binds. A file declaring another program is
  // never re-labelled (the rule src/adopt.mjs measures: a declared program
  // that differs from the receipt's program is a re-labelling, refused).
  if (idl.address !== HADRON_PROGRAM) {
    throw new HadronPinError(
      'hadron-address-disagrees',
      `vendored file declares ${idl.address ?? 'nothing'}, pin binds ${HADRON_PROGRAM}`,
    );
  }
  if (!Array.isArray(idl.instructions) || idl.instructions.length === 0) {
    throw new HadronPinError('hadron-no-instructions', 'not an interface copy');
  }
  // THE MEASURED REASON FOR SHIPPING THIS FILE: each of the two arguments the
  // on-chain copy lacks must be present, last, and typed u64. A copy that lost
  // them would still hash correctly against nothing in particular — the pin
  // covers BYTES, this check covers the CLAIM those bytes make.
  const byName = new Map(idl.instructions.map((instruction) => [instruction.name, instruction]));
  const declaredMissing = [];
  for (const expected of HADRON_MISSING_ARGS) {
    const instruction = byName.get(expected.instruction);
    if (!instruction) {
      throw new HadronPinError('hadron-instruction-missing', `${expected.instruction} is not in the vendored copy`);
    }
    const args = Array.isArray(instruction.args) ? instruction.args : [];
    const last = args[args.length - 1];
    if (last?.name === expected.arg && last?.type === expected.type) {
      declaredMissing.push({ ...expected });
    }
    // A copy WITHOUT the argument is still adopted honestly — it just cannot
    // claim the reason this module exists, so `declaredMissing` stays short
    // and the adopting caller reports the shortfall instead of the promise.
  }
  if (declaredMissing.length !== HADRON_MISSING_ARGS.length) {
    throw new HadronPinError(
      'hadron-tail-args-absent',
      `this copy declares ${declaredMissing.length}/${HADRON_MISSING_ARGS.length} of the sequence:u64 tails `
      + `the acquisition exists for (${HADRON_MISSING_ARGS.map((a) => `${a.instruction}.${a.arg}`).join(', ')}) `
      + '— adopting it would promise byte-exactness it cannot deliver',
    );
  }
  return { idl, path: vendoredPath, sha256: now, bytes: raw.length, declaredMissing };
}

/**
 * The origin label adopt records.
 *
 * `sememe adopt` sanitizes the caller's label to a filename-safe form and
 * caps it at 64 characters (src/adopt.mjs, `safeLabel`). A label longer than
 * that is TRUNCATED, silently: the obvious label for this acquisition
 * (`Hadron-Fi/hadron-tx-verifier@<40-hex commit>:idl/hadron.json`) is 96
 * characters and comes back as a 64-char prefix that has LOST the tail of the
 * commit hash and the whole file path — the same thing that already happens
 * to the 105-character lighthouse origin. A commit truncated to 35 hex
 * characters is not a commit, so this label drops the file path and the owner
 * on purpose and keeps the FULL 40-hex commit: 59 characters, recorded whole.
 * The owner and the file are in HADRON_PIN, beside the sha256 of every
 * vendored byte — and the commit here is the directory the bytes live in.
 */
export function hadronOriginLabel() {
  return `hadron-tx-verifier@${HADRON_PIN.commit}`;
}

/**
 * Adopt the verified first-party copy into a store through the PRODUCT's one
 * write path (src/adopt.mjs — the same path `sememe adopt` uses).
 *
 * Order is the point: the pin is checked FIRST, so a tampered, missing or
 * tail-less vendored file means NOTHING was written. The receipt's origin
 * stays `declared`: the pin binds the BYTES to a commit, not the bytes to the
 * deployed program.
 */
export async function adoptHadron(storeDir, { adopt } = {}) {
  if (typeof adopt !== 'function') throw Error('adoptHadron needs the product write path (src/adopt.mjs)');
  const loaded = loadVendoredHadron();
  const receipt = await adopt(HADRON_PROGRAM, loaded.path, storeDir, {
    source: 'published',
    origin: hadronOriginLabel(),
  });
  return { receipt, loaded };
}
