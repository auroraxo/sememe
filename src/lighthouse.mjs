// The Lighthouse acquisition: a pinned, hash-verified first-party published
// IDL for the program that was the LARGEST remaining acquisition gap after
// ATA (measured 2026-11-11: L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95,
// 1,214 payloads in 6 finalized blocks, no IDL account at either pullable
// address — research/ecosystem-coverage-2026-11-11.json, acquisitionQueue[0]).
//
// WHY THIS FILE EXISTS
//
// `sememe adopt` stores any file the caller names, and its origin is DECLARED,
// never verified (src/adopt.mjs says so on every surface). For ATA the answer
// was a derived wire table pinned to the vendored upstream Rust. For Lighthouse
// the answer already exists as a FIRST-PARTY PUBLISHED COPY: the program's own
// repository ships programs/lighthouse/lighthouse.json (shank dialect, which
// src/shank.mjs decodes — measured 2026-11-04 on 42 payloads of the foreign
// sweep). The gap was never "no interface exists"; it was "no one can adopt it
// reproducibly". This module makes the adoption checkable:
//
//   - the copy is VENDORED under vendor/lighthouse/<commit>/ with the commit
//     it was read at and the sha256 of every file (license MIT, LICENSE
//     vendored beside it);
//   - loadVendoredLighthouse() re-hashes the vendored bytes against the pin
//     and REFUSES by name on any mismatch, missing file, unparseable JSON, a
//     declared address that disagrees, or a non-shank instruction table —
//     the same two-check contract src/native.mjs / src/token.mjs /
//     src/raydium.mjs / src/ata.mjs prove;
//   - the shank discriminants themselves are checked for self-consistency
//     (every instruction declares {type:'u8',value:N}; N must be the
//     declaration index) so a doctored IDL cannot claim 0x00 for two
//     instructions.
//
// What is deliberately NOT claimed: the vendored bytes are not proven to come
// from the commit by this module (GitHub blobs are content-addressed, git
// commits are not signed here); the receipt will say originStatus 'declared'
// and name repo + commit + file. Chain proof stays with the decode: every
// payload must still re-encode byte-exactly or the union refuses.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

export const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';

export const LIGHTHOUSE_PIN = {
  repo: 'Jac0xb/lighthouse',
  commit: '4c579479c98635e419b1b167f08be02a71604a71',
  license: 'MIT',
  // sha256 of the bytes AS PUBLISHED at the commit, read via the GitHub
  // contents API at that ref (not from a mutable working tree).
  files: [
    {
      file: 'programs/lighthouse/lighthouse.json',
      role: 'first-party published IDL (shank dialect: per-instruction u8 discriminant)',
      sha256: '9c54749abd27c09cf8d61e50016b625b5ae4aeb5cb1b8baf295199a1d7ecfd48',
    },
    {
      file: 'LICENSE',
      role: 'the license the vendored copy ships under',
      sha256: '64d73100cafc1f5cb148cbbd5b3c7fc74bafc46f156646b0861c698570d02327',
    },
  ],
  origin: `github.com/${'Jac0xb/lighthouse'}@4c579479c98635e419b1b167f08be02a71604a71:programs/lighthouse/lighthouse.json`,
};

export function vendoredLighthousePath(file, root = REPO_ROOT) {
  return path.join(root, 'vendor', 'lighthouse', LIGHTHOUSE_PIN.commit, path.basename(file));
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export class LighthousePinError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'LighthousePinError';
    this.reason = reason;
  }
}

/**
 * Read the vendored IDL and verify it against the pin. Every refusal is
 * NAMED — a caller can tally failure faces without parsing prose.
 * Returns { idl, path, sha256, bytes } on success.
 */
export function loadVendoredLighthouse(root = REPO_ROOT, pin = LIGHTHOUSE_PIN) {
  const pinned = pin.files.find((f) => f.file.endsWith('lighthouse.json'));
  const vendoredPath = path.join(root, 'vendor', 'lighthouse', pin.commit, path.basename(pinned.file));
  let raw;
  try {
    raw = readFileSync(vendoredPath);
  } catch (error) {
    throw new LighthousePinError(
      'lighthouse-vendor-missing',
      `${vendoredPath} is not present (${error.code ?? error.message})`,
    );
  }
  const now = createHash('sha256').update(raw).digest('hex');
  if (now !== pinned.sha256) {
    throw new LighthousePinError(
      'lighthouse-vendor-hash-mismatch',
      `pinned ${pinned.sha256}, hashed now ${now} — refusing to adopt bytes that are not the reviewed copy`,
    );
  }
  let idl;
  try {
    idl = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new LighthousePinError('lighthouse-vendor-unparseable', String(error.message ?? error));
  }
  if (!idl || typeof idl !== 'object' || Array.isArray(idl)) {
    throw new LighthousePinError('lighthouse-vendor-unparseable', 'not an IDL object');
  }
  // Address binding: this file claims Lighthouse by its own metadata, and the
  // program id this module pins is the one the measurement saw. A file that
  // declares a different program refuses, it is never re-labelled.
  const declared = idl.metadata?.address ?? idl.address ?? null;
  if (declared !== LIGHTHOUSE_PROGRAM) {
    throw new LighthousePinError(
      'lighthouse-address-disagrees',
      `vendored file declares ${declared}, pin binds ${LIGHTHOUSE_PROGRAM}`,
    );
  }
  if (!Array.isArray(idl.instructions) || idl.instructions.length === 0) {
    throw new LighthousePinError('lighthouse-no-instructions', 'not an interface copy');
  }
  // Shank table integrity: every instruction must declare a u8 discriminant
  // equal to its declaration index (measured truth at the pin: 0..17 in
  // order). This is the IDL checking ITSELF, not a transcription.
  idl.instructions.forEach((instruction, index) => {
    const disc = instruction?.discriminant;
    if (!disc || disc.type !== 'u8' || disc.value !== index) {
      throw new LighthousePinError(
        'lighthouse-discriminant-table',
        `instruction ${index} (${instruction?.name}) discriminant ` +
        JSON.stringify(disc ?? null) + ` is not the shank u8 value ${index}`,
      );
    }
  });
  return { idl, path: vendoredPath, sha256: now, bytes: raw.length };
}

/** The origin label adopt records for a load that passed the pin checks. */
export function lighthouseOriginLabel() {
  return `github.com/${LIGHTHOUSE_PIN.repo}@${LIGHTHOUSE_PIN.commit}:programs/lighthouse/lighthouse.json`;
}

/**
 * Adopt the verified first-party copy into a store, through the PRODUCT's one
 * write path (src/adopt.mjs — the same path `sememe adopt` uses).
 *
 * Order matters and is the point of this function: the pin is checked FIRST,
 * so a tampered or missing vendored file means NOTHING was written. The
 * receipt's origin stays `declared` (adopt's own rule): the pin binds the
 * BYTES to a commit, not the bytes to the deployed program.
 */
export async function adoptLighthouse(storeDir, { adopt } = {}) {
  if (typeof adopt !== 'function') throw Error('adoptLighthouse needs the product write path (src/adopt.mjs)');
  const loaded = loadVendoredLighthouse();
  const receipt = await adopt(LIGHTHOUSE_PROGRAM, loaded.path, storeDir, {
    source: 'published',
    origin: lighthouseOriginLabel(),
  });
  return { receipt, loaded };
}
