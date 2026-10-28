// Compare a re-derived harvest against the fixture it claims to reproduce.
//
// Why this exists: `--from-signatures` re-fetches transactions from a public
// RPC, and a public RPC rate-limits. A run that fetched 37 of 40 transactions
// still writes a file, still exits 0, and still "looks" like a reproduction.
// Without an explicit comparison the difference between *reproduced* and
// *partially fetched* is invisible — and a partial fetch that happens to drop
// the interesting transactions would silently shrink the measurement.
//
// The comparison answers, separately:
//   - every pinned signature came back (`missing`)
//   - the payloads of every fetched transaction are byte-identical (`mismatched`)
// It reports mismatches with an example so a failure is diagnosable.
//
// Pure: no network, no filesystem. Callers decide what to do with the result.

/**
 * Compare an expected fixture with a re-derived document.
 *
 * @param {object} expected the committed fixture
 * @param {object} actual   document produced by `--from-signatures`
 * @returns {{
 *   pinned:number, fetched:number, missing:string[], payloadSetsChecked:number,
 *   payloadSetsMatched:number, mismatched:{signature:string, expected:number,
 *   actual:number, firstDifference:string|null}[], payloadBytesMatched:boolean
 * }}
 */
export function compareReDerived(expected, actual) {
  const expectedTxs = Array.isArray(expected?.transactions) ? expected.transactions : [];
  const actualBySignature = new Map(
    (Array.isArray(actual?.transactions) ? actual.transactions : [])
      .map((entry) => [entry?.signature, entry]),
  );

  const missing = [];
  const mismatched = [];
  let fetched = 0;
  let payloadSetsChecked = 0;
  let payloadSetsMatched = 0;

  for (const entry of expectedTxs) {
    const got = actualBySignature.get(entry.signature);
    if (!got || got.missing) {
      missing.push(entry.signature);
      continue;
    }
    fetched++;
    payloadSetsChecked++;
    const want = entry.payloads ?? [];
    const have = got.payloads ?? [];
    if (JSON.stringify(want) === JSON.stringify(have)) {
      payloadSetsMatched++;
      continue;
    }
    mismatched.push({
      signature: entry.signature,
      expected: want.length,
      actual: have.length,
      firstDifference: firstDifference(want, have),
    });
  }

  // `payloadBytesMatched` is a claim about the WHOLE pinned set, not about what
  // happened to arrive. A fetch that returned 37 of 40 transactions matches
  // perfectly on those 37 and still fails to reproduce the fixture — letting
  // the partial run call itself byte-exact is the confusion this module exists
  // to prevent.
  return {
    pinned: expectedTxs.length,
    fetched,
    missing,
    payloadSetsChecked,
    payloadSetsMatched,
    mismatched,
    payloadBytesMatched: missing.length === 0 && mismatched.length === 0 && payloadSetsChecked > 0,
  };
}

/** Where two payload arrays first differ, in words short enough to print. */
function firstDifference(want, have) {
  if (want.length !== have.length) return `payload count ${want.length} vs ${have.length}`;
  for (const [index, payload] of want.entries()) {
    const other = have[index];
    if (payload?.dataHex !== other?.dataHex) return `payload ${index} dataHex differs`;
    if (payload?.ix !== other?.ix) return `payload ${index} ix ${payload?.ix} vs ${other?.ix}`;
    if (payload?.depth !== other?.depth) return `payload ${index} depth ${payload?.depth} vs ${other?.depth}`;
    if (payload?.innerIndex !== other?.innerIndex) return `payload ${index} innerIndex ${payload?.innerIndex} vs ${other?.innerIndex}`;
  }
  return 'payloads differ in a field not compared';
}

/**
 * Whether a re-derivation is complete enough to call a reproduction.
 *
 * Incomplete is reported, never asserted as success: a caller that wanted a
 * reproduction must be able to tell the two apart from the exit code alone.
 */
export function isCompleteReproduction(result) {
  // Equivalent to result.payloadBytesMatched, stated separately because the
  // two answer different questions: one is about the bytes, the other is the
  // predicate a caller exits on.
  return result.missing.length === 0
    && result.mismatched.length === 0
    && result.payloadSetsChecked > 0;
}
