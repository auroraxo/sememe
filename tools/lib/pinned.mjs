// Resolve the signature list that re-derives a harvest document's payloads.
//
// Why this exists: a harvest is only reproducible if the signatures it was
// built from travel WITH it. A document that carries payloads but no pinnable
// signature looks complete and re-derives to nothing — the "silently zero"
// failure mode, one level up from the extraction bugs.
//
// Which list to use is not obvious, and getting it wrong re-derives the wrong
// set. Two lists exist in a full harvest:
//   - `transactions`: the transactions actually read (the payload set)
//   - `signatures`: the getSignaturesForAddress page that selected the blocks
// They are NOT the same set. Measured on this repo's own harvest: Whirlpool is
// invoked mostly by CPI, and a CPI-only transaction does not appear in
// getSignaturesForAddress for the callee — only 298 of the 1,029
// payload-bearing transactions were in that page. Re-deriving payloads from the
// page would silently drop the other 731.
//
// So the transaction records win: they name the payload set exactly. The
// declared `signatures` array is the fallback when a document carries no
// transactions (e.g. a signature-only index).
//
// Neither present → throw. Silently re-deriving zero transactions would look
// like a successful run while proving nothing.
//
// Pure: no network, no filesystem. The caller decides what to do with the list.

/**
 * The signature entries a harvest document pins, in a stable order.
 *
 * @param {object} document parsed harvest document
 * @returns {{ signature: string, slot: number|null, blockTime: number|null }[]}
 * @throws when the document pins no signature at all
 */
export function pinnedSignaturesOf(document) {
  if (!document || typeof document !== 'object') {
    throw Error('harvest document is not an object');
  }

  // Preferred: the transactions this document actually contains. A compact
  // fixture keeps only payload-bearing transactions, and those still name
  // their signature and slot.
  const fromTransactions = (Array.isArray(document.transactions) ? document.transactions : [])
    .map((entry) => ({
      signature: entry?.signature,
      slot: Number.isSafeInteger(entry?.slot) ? entry.slot : null,
      blockTime: Number.isSafeInteger(entry?.blockTime) ? entry.blockTime : null,
    }))
    .filter((entry) => typeof entry.signature === 'string' && entry.signature.length);

  if (fromTransactions.length) return fromTransactions;

  // Fallback: a declared list, accepting both the object form the harvester
  // writes and bare signature strings.
  const declared = document.signatures;
  if (Array.isArray(declared)) {
    const usable = declared
      .map((entry) => (typeof entry === 'string'
        ? { signature: entry, slot: null, blockTime: null }
        : entry))
      .filter((entry) => entry && typeof entry.signature === 'string' && entry.signature.length);
    if (usable.length) return usable;
  }

  throw Error(
    'harvest document pins no signatures: it has neither transactions carrying a signature '
    + 'nor a usable "signatures" array, so it cannot be re-derived',
  );
}

/**
 * True when the document pins at least one signature. Used by callers that
 * want to check without throwing.
 */
export function hasPinnedSignatures(document) {
  try {
    return pinnedSignaturesOf(document).length > 0;
  } catch {
    return false;
  }
}
