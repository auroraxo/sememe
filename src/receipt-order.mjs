// ONE ordering for store receipts — because two orderings are two answers.
//
// The receipt filename is `<program>-<slot>-<source>-<fingerprint>.json`, and
// the SLOT inside it is a decimal number stored as a string. Sorting receipt
// names with a plain string comparison therefore orders by DIGITS, not by
// value: `…-99999999-…` sorts AFTER `…-123456789-…`, so the OLDER receipt wins
// "last position" — and `findStoredIdl` takes the last position as "newest".
//
// Measured 2026-11-07 (this host, pre-fix tree 00ae18c, the code the published
// v0.4.9 carries): with one program's receipts at slots 99999999 and 123456789
// in one store, `sememe decode` answered from slot 99999999 while
// `sememe decode --union` answered from 123456789 — the union path has always
// sorted on-chain receipts by NUMERIC slot (`onChain.sort((a, b) => a.slot -
// b.slot)`), while the plain reader and src/lock.mjs sorted by filename. Two
// sorts, two winners: the same defect shape 08eff55 fixed for labels, one
// dimension over, and the reason "the rule is now ONE ordering everywhere"
// was not yet true.
//
// The rule here:
//   1. by SLOT, numerically (adopted copies carry filename segment 0, so they
//      sort before every real slot — adoption never switches the default
//      source, the selection guard the union tests protect);
//   2. ties broken by the REST of the filename, byte-wise — so two receipts of
//      the same slot (different sources) keep a deterministic, reproducible
//      order instead of depending on readdir() order.
//
// Why parse the filename instead of reading each receipt: the selection rule
// must be computable before opening files (findStoredIdl filters and sorts
// first, and lock.mjs does the same), and it must not depend on which receipts
// are readable — an unreadable receipt is named by readVerified, not silently
// re-ordered around.

const RECEIPT_NAME = /^(?<program>[^-]+)-(?<slot>\d+)-(?<rest>.*)$/;

/** The slot a receipt filename declares, or null when the name is not a
 * receipt name this rule understands (never happens for pull/adopt output). */
export function slotOfReceiptName(name) {
  const match = RECEIPT_NAME.exec(name);
  if (!match) return null;
  const slot = Number(match.groups.slot);
  return Number.isSafeInteger(slot) ? slot : null;
}

/**
 * Compare two receipt filenames: numeric slot first, filename as tiebreak.
 * Names this rule cannot parse sort before parsed ones (stable, deterministic)
 * so an unexpected name can never displace a real receipt's position silently.
 */
export function compareReceiptNames(a, b) {
  const slotA = slotOfReceiptName(a);
  const slotB = slotOfReceiptName(b);
  if (slotA !== null && slotB !== null && slotA !== slotB) return slotA - slotB;
  if (slotA === null && slotB !== null) return -1;
  if (slotA !== null && slotB === null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
