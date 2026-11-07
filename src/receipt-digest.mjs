// The receipt's own digest — so a DECLARED field cannot be rewritten silently.
//
// The store binds BYTES by content address: the object's fingerprint is
// sha256(canonicalJson(idl) + '\n'), and every reader re-hashes the object
// before it decodes. The RECEIPT was never covered by anything: it is a JSON
// file next to the object, and every field in it is free text after the fact.
//
// Measured 2026-11-07 (this host, the published v0.4.10 tree, main 939b320):
// rewriting `origin` in a receipt to `attacker/rewritten-origin` and running
// `sememe verify --mode warn` reported
//   violations: 0   verified: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"]
// The fingerprint covers the object; the ORIGIN next to it was covered by
// nothing, so the CI gate stayed green over a rewritten provenance label.
//
// The fix mirrors the object pattern one level up: the receipt carries a
// digest over ITS OWN BODY, so a reader can tell "this receipt was written by
// sememe" from "this file was edited afterwards" — exactly the question the
// object fingerprint already answers for the bytes.
//
//   receiptDigest  sha256(canonicalJson(body without receiptDigest) + '\n')
//   originDigest   sha256(origin)      — binds the DECLARED label on its own,
//                                          so a rewrite of the label ALONE is
//                                          named as a label rewrite and not
//                                          as an anonymous body change.
//
// The digest is over the CANONICAL serialization, the same one the store
// fingerprints objects with, so a receipt is reproducible from its body alone.
//
// COMPATIBILITY: receipts written before this field existed carry NO digest.
// They are read as they always were (the origin is then treated as DECLARED
// without a binding). A legacy receipt is never refused for lacking a digest —
// only a receipt whose digest DISAGREES is refused.

import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.mjs';

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/** The receipt body WITHOUT its own digest field. */
export function receiptBody(receipt) {
  const { receiptDigest, ...body } = receipt ?? {};
  return body;
}

/** The digest a receipt body must carry. */
export function receiptDigestOf(receipt) {
  return `sha256:${sha256Hex(`${canonicalJson(receiptBody(receipt))}\n`)}`;
}

/** The digest a declared origin must carry. */
export function originDigestOf(origin) {
  return `sha256:${sha256Hex(String(origin))}`;
}

/** The two checks a reader runs on a receipt that carries the new fields.
 * Returns null when the receipt is consistent, or a named reason when it is
 * not. `relabelled` distinguishes "the declared origin was rewritten" from
 * "some other field of the receipt was rewritten" — the lock reports the two
 * differently, because they are different failures. */
export function receiptIntegrity(receipt) {
  const origin = receipt?.origin;
  if (typeof receipt?.originDigest === 'string' && origin !== undefined && origin !== null) {
    if (originDigestOf(origin) !== receipt.originDigest) {
      return {
        code: 'receipt-relabelled',
        reason: `the declared origin was rewritten after the receipt was written `
          + `(the receipt still binds "${originDigestOf(origin)}" but the receipt claims `
          + `${receipt.originDigest}) — refusing to read it as provenance`,
      };
    }
  }
  if (typeof receipt?.receiptDigest === 'string') {
    const actual = receiptDigestOf(receipt);
    if (actual !== receipt.receiptDigest) {
      return {
        code: 'receipt-tampered',
        reason: `the receipt was modified after it was written `
          + `(body digest ${actual}, receipt claims ${receipt.receiptDigest}) — `
          + `refusing to read it as provenance`,
      };
    }
  }
  return null;
}
