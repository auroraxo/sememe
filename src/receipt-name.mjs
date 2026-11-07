// ONE classifier for what a file in `receipts/` actually IS.
//
// The store's receipt directory holds two kinds of things, and until now the
// readers treated EVERY file in it as a receipt:
//
//   1. a RECEIPT — `<program>-<slot>-<source>-<fingerprint>.json`, written by
//      `sememe pull` (src/pull.mjs) or `sememe adopt` (src/adopt.mjs). The
//      fingerprint is the sha256 of the stored object; the slot is a decimal
//      number (0 for an adopted copy); the source is a short label; an adopted
//      copy may carry an extra `<originKey>` segment.
//   2. DEBRIS — a file nobody committed. The most common source is sememe
//      ITSELF: src/store-write.mjs writes every receipt and object through a
//      temporary file `<name>.tmp-<pid>-<random>` in the SAME directory and
//      removes it in a `finally`. A crash between the write and the cleanup
//      (SIGKILL, power loss, OOM) leaves that file behind FOREVER.
//
// MEASURED 2026-11-07 (this host, pre-fix tree a7848d4): one leftover
// `.tmp-4711-9f2c1a` file in `receipts/` broke EVERY surface of the product:
//
//   sememe decode <program> <payload>   -> EXIT 1 "store receipt <tmp file>
//                                          is unreadable: Unexpected token"
//   sememe decode --union <program> ... -> EXIT 1, same refusal
//   sememe lock                         -> EXIT 1, "Cannot destructure
//                                          property 'idl' of (intermediate
//                                          value) as it is null"
//   sememe verify --mode error          -> EXIT 1, "unverified: <program>"
//
// The last one is the worst: the gate went RED and named a program that was
// perfectly intact, and the repair was never named — the user is told to
// re-pull a healthy program. One crashed write permanently bricked the store.
//
// WHY THE DEBRIS IS SAFE TO IGNORE (this is the reason, not a convenience):
// store-write.mjs installs a receipt by HARD-LINKING the temporary file to its
// final name (`link(temporary, destination)`) and only then removes the
// temporary. So the temporary file never holds anything the final name does
// not also hold:
//   - died BEFORE the link  -> only the temp exists; the receipt was never
//     committed, so there is nothing to read;
//   - died AFTER the link   -> the final name holds the receipt AND the temp
//     holds a byte-identical copy of it, so the temp carries no information
//     the committed receipt does not.
// Either way the debris is an UNCOMMITTED write, and ignoring it cannot hide
// an answer.
//
// THE OTHER TWO KINDS, and why they are not debris:
//   - MALFORMED — a name that LOOKS like a receipt (it has a numeric slot
//     segment) but is not well-formed (the fingerprint is not 64 hex, the
//     name was truncated, an editor left a suffix). This is DAMAGE to the
//     store: it may be a receipt that was renamed or corrupted. It stays in
//     the verified set, so the reader refuses it by name — exactly as it did
//     before. Classifying it as ignorable junk would be a NEW green lie: a
//     renamed receipt would vanish from the store's answers without a word.
//   - FOREIGN — anything else in the directory (`.DS_Store`, `README`, a
//     user's own note). It names no program and carries no slot, so it is
//     not a receipt and never was one. Today it was read as one: `.DS_Store`
//     became a PHANTOM program in `sememe verify` ("extra: [.DS_Store]"), and
//     `my-file.json` became a phantom program "my" that FAILED the gate
//     ("unverified: my") — a false red over a file that was never a receipt.
//
// So the rule is narrow on purpose: only what can be PROVEN to be an
// uncommitted write is ignored. Everything else keeps its previous verdict.
//
// A receipt whose name matches the grammar is a receipt WHATEVER its program
// id looks like — the grammar says nothing about base58, because a store may
// hold a synthetic program id and a reader that dropped such a receipt would
// be the green lie this repo keeps killing.

/** A receipt filename: `<program>-<slot>-<middle>-<64 hex>.json`.
 * The middle segment may itself contain dashes (an adopted copy carries an
 * extra `<originKey>`), so the fingerprint tail is anchored at the end. */
const RECEIPT_GRAMMAR = /^[^-]+-\d+-.+-[a-f0-9]{64}\.json$/;

/** sememe's own temporary file: `<something>.tmp-<pid>-<random hex>`. */
const DEBRIS_GRAMMAR = /\.tmp-\d+-[0-9a-f]+$/;

/** A name that looks like a receipt: it carries a numeric slot segment.
 * `<program>-<slot>-...` — the shape every receipt has, whether or not the
 * rest of the name is well-formed. */
const RECEIPT_SHAPED = /^[^-]+-\d+-/;

/**
 * What one file in `receipts/` is.
 *
 * Returns one of:
 *   'receipt'   a well-formed receipt — read it, verify it, bind it.
 *   'malformed' receipt-shaped but not well-formed — DAMAGE: read it so the
 *               refusal names it; never ignore it.
 *   'debris'    sememe's own uncommitted temporary file — ignore it, report
 *               it by name.
 *   'foreign'   a file that is not a receipt at all — ignore it, report it
 *               by name.
 *
 * The order matters: the debris rule is checked FIRST, because a debris file
 * of a receipt-shaped name (`<receipt>.tmp-<pid>-<hex>`) is still debris —
 * sememe's own leftovers are exactly the ones that carry a slot segment.
 */
export function classifyReceiptFile(name) {
  if (DEBRIS_GRAMMAR.test(name)) return 'debris';
  if (RECEIPT_GRAMMAR.test(name)) return 'receipt';
  if (RECEIPT_SHAPED.test(name)) return 'malformed';
  return 'foreign';
}

/** True for the kinds that are receipts for the purposes of reading a store:
 * well-formed receipts, and malformed ones (which must still be refused by
 * name rather than skipped in silence). */
export function isReceiptFile(name) {
  const kind = classifyReceiptFile(name);
  return kind === 'receipt' || kind === 'malformed';
}

/**
 * Partition a directory listing into the four kinds.
 *
 * `receipts` are the names to read and verify; `stray` are the names to
 * report but not read (each with the kind that excluded it, so the report
 * can say WHY a file was ignored).
 */
export function classifyReceiptFiles(names) {
  const receipts = [];
  const stray = [];
  for (const name of names) {
    const kind = classifyReceiptFile(name);
    if (kind === 'receipt' || kind === 'malformed') receipts.push(name);
    else stray.push({ name, kind });
  }
  return { receipts, stray };
}
