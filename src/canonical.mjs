// Canonical JSON — the exact serialization the store fingerprints.
//
// Lives in its own module so a CONSUMER can verify a receipt without
// pulling in the acquisition path: `src/pull.mjs` imports @solana/web3.js
// (PDA derivation), and a dependency-free repository that only wants to
// confirm "these bytes are the bytes the receipt claims" must not have to
// install it. `src/pull.mjs` re-exports this, so nothing that imports
// `canonicalJson` from there changes.
//
// Property order is sorted, arrays keep their order, and every value must be
// JSON-encodable. Two structurally equal objects therefore always produce
// the same bytes, which is what makes sha256(canonicalJson(idl) + '\n') a
// content address rather than a snapshot of whatever JSON.stringify felt
// like doing that day.

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('non-JSON value');
  return encoded;
}
