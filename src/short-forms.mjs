// Chain-verified short wire forms: payloads the DEPLOYED program executed that
// the stored interface describes as one field LONGER than the bytes on the wire.
//
// Why this table exists, and why it is not simply "decode when a payload ends
// at a field boundary":
//
// Byte-exact re-encoding is NOT sufficient evidence for an absent field. With
// `trailing` it is: a complete described prefix that re-encodes exactly means
// the extra bytes are extra, and the described part is whole. With `absent` it
// is not — a payload truncated by a capture bug also ends on a field boundary
// and also re-encodes byte-exactly to the shortened bytes. So offline, on bytes
// alone, "the deployed program accepts a shorter form" and "this payload was
// cut short" are indistinguishable. src/codec.mjs therefore keeps
// `absent: 'error'` as the default and refuses both.
//
// What makes the shorter form KNOWABLE is a chain witness. Each entry below was
// measured on mainnet by tools/short-form-wire-forms.mjs against
// research/short-form-wire-forms-2026-11-03.json (the 4-block window) and
// research/short-form-wire-forms-2026-11-04.json (the 32-block window):
//
//   - the transaction's `err` field is null (the chain accepted it),
//   - the witness instruction bytes are byte-IDENTICAL to the fixture payload,
//   - the program's own log line names the instruction the decode will report.
//
// On the 2026-11-03 12,572-payload sample that resolved 171 of the 172
// refusals: 0 of them were genuine chain-rejected refusals. The 2026-11-04
// 89,546-payload window resolved 350 of 350 refusals the same way, and found
// three MORE short forms the first window had never seen — because the table
// is keyed on program + discriminator + exact length, and the first window
// simply did not contain them: pump.fun's bonding curve executes the 24-byte
// `buy` form that had only been witnessed on PumpSwap, plus `buy_exact_sol_in`
// and the 146-byte `create_v2`, which omits THREE declared fields.
//
// The table is the product form of those measurements — the evidence travels
// with the decoder, so `absent: 'verified'` can name these forms while still
// refusing every other payload that happens to end on a field boundary.
//
// A payload must match program + discriminator + EXACT wire length. Matching
// the discriminator alone is not enough: the 25-byte form of
// e1f7501ed5b38488 is a different, fully-described shape and must not be routed
// through the absent path (it is not absent — both OptionBools are present).

/**
 * Verified short wire forms.
 *
 * `program`  deployed program address the witness belongs to
 * `bytes`    exact payload length, discriminator included
 * `absent`   declared fields the wire does not carry, in declaration order —
 *            named here so a decode that reports a DIFFERENT absent set does
 *            not silently count as verified
 */
const VERIFIED_SHORT_FORMS = [
  {
    program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    discriminator: 'e1f7501ed5b38488',
    bytes: 24,
    instruction: 'buy_exact_quote_in_v3',
    absent: ['partial_fill'],
    witnesses: 152,
  },
  {
    program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    discriminator: '07051dc4f5176550',
    bytes: 24,
    instruction: 'buy_v3',
    absent: ['partial_fill'],
    witnesses: 1,
  },
  {
    program: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    discriminator: 'c62e1552b4d9e870',
    bytes: 24,
    instruction: 'buy_exact_quote_in',
    absent: ['track_volume'],
    witnesses: 17,
  },
  {
    program: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    discriminator: '66063d1201daebea',
    bytes: 24,
    instruction: 'buy',
    absent: ['track_volume'],
    witnesses: 1,
  },
  // --- 2026-11-04 window (research/short-form-wire-forms-2026-11-04.json) ---
  // The same 24-byte `buy` form, on pump.fun's BONDING CURVE program. The
  // discriminator and the length match the PumpSwap entry above, but the
  // program is a different deployment, so the 2026-11-03 window could not
  // witness it: the key is program + discriminator + exact length, and only
  // one of the two programs was measured then.
  {
    program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    discriminator: '66063d1201daebea',
    bytes: 24,
    instruction: 'buy',
    absent: ['track_volume'],
    witnesses: 7,
  },
  {
    program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    discriminator: '38fc74089edfcd5f',
    bytes: 24,
    instruction: 'buy_exact_sol_in',
    absent: ['track_volume'],
    witnesses: 1,
  },
  // The first short form that omits MORE THAN ONE declared field: the
  // interface declares three, the wire carries none of them.
  {
    program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    discriminator: 'd6904cec5f8b31b4',
    bytes: 146,
    instruction: 'create_v2',
    absent: ['is_cashback_enabled', 'creator_fee_bps', 'is_holder_reward'],
    witnesses: 1,
  },
  // --- 2026-11-12: the first short form whose missing field sits INSIDE a
  // struct argument (research/archer-legacy-swap-witness-2026-11-12.json).
  // Every form above ends at a TOP-LEVEL argument boundary; this one ends on
  // the boundary of the LAST field inside `swapParams`, so the absent name
  // is dotted (`swapParams.builderFeePpm`) and the codec's struct-boundary
  // rule is what makes it decodable. Evidence: a Swap executed at slot
  // 468261978 with err:null whose instruction bytes are byte-identical to
  // the 19-byte payload (checked against the RPC witness twice: `json`
  // encoding base58 -> 0f430000000000000000000000000000000100), the Archer
  // CPI's own `success` line, and the pinned IDL's SwapParams docs which
  // describe the shorter legacy payload as a supported form read as a 0 fee.
  {
    program: 'Archer8kgiavM61GyusMzaaS2ft5sALtNsD1HxkUPMhy',
    discriminator: '0f',
    bytes: 19,
    instruction: 'Swap',
    absent: ['swapParams.builderFeePpm'],
    witnesses: 1,
    missingFieldInsideStruct: true,
  },
];

export const SHORT_FORM_SOURCE =
  'research/short-form-wire-forms-2026-11-03.json + research/short-form-wire-forms-2026-11-04.json '
  + '(chain witnesses: err:null, byte-identical payload, matching program log line) '
  + 'research/archer-legacy-swap-witness-2026-11-12.json (chain witness: err:null, byte-identical payload)';

export const VERIFIED = VERIFIED_SHORT_FORMS;
export { VERIFIED_SHORT_FORMS };

/** Look up a payload in the chain-verified short-form table; null when absent. */
export function verifiedShortForm(program, data) {
  // Struct-internal short forms may carry a discriminator SHORTER than 8
  // bytes (measured: Archer's shank tag, 1 byte). The old `data.length < 8`
  // guard refused any lookup that could not yield such a match: a 19-byte
  // payload with a 1-byte tag reaches the table fine once the prefix is
  // clipped to min(8, len) — exactly the rule the codec's instruction index
  // already uses for short stored discriminators.
  if (!program || !(data instanceof Uint8Array)) return null;
  if (data.length === 0) return null;
  const prefixLength = Math.min(8, data.length);
  const discriminator = Buffer.from(data.subarray(0, prefixLength)).toString('hex');
  return VERIFIED_SHORT_FORMS.find((entry) =>
    entry.program === program
    && discriminator.startsWith(entry.discriminator)
    && entry.bytes === data.length) ?? null;
}

/**
 * Resolve an `absent` policy into the codec policy for one payload.
 *
 *   'error'    never decode absent fields (the strict default)
 *   'report'   decode any payload that ends on a field boundary (caller risk)
 *   'verified' decode only forms in the chain-verified table; anything else
 *              stays strict — the evidence-gated policy
 */
export function resolveAbsentPolicy(program, data, policy) {
  if (policy === undefined || policy === null || policy === 'error') return { policy: 'error', form: null };
  if (policy === 'report') return { policy: 'report', form: null };
  if (policy !== 'verified') {
    throw new Error(`unknown absent policy ${JSON.stringify(policy)}`);
  }
  const form = verifiedShortForm(program, data);
  return { policy: form ? 'report' : 'error', form };
}

/**
 * Assert that a completed decode reproduces the measured wire form.
 *
 * Throws when it does not. This is the single place the rule lives, so the
 * product paths (single-source and union) cannot drift apart from it, and so
 * the rule can be tested directly with synthetic decodes — a different missing
 * set, a different name — instead of only through a fixture store.
 */
export function assertShortFormEvidence(form, decoded, bytes) {
  const evidence = describeShortForm(form, decoded, bytes);
  if (!evidence.verified) {
    throw new Error(
      `short-form evidence does not cover this decode: measured absent `
      + `${JSON.stringify(form.absent)} for ${form.instruction}, decoded `
      + `${JSON.stringify(evidence.decodeAbsence)} — refusing instead of trusting stale evidence`);
  }
  return evidence;
}

/**
 * Does a completed decode reproduce the measured wire form?
 *
 * Pure on purpose: the rules for trusting old chain evidence are worth testing
 * directly with synthetic decodes (a different missing set, a different name)
 * rather than only through a fixture store. Returns the evidence object with
 * `verified` set — it never throws, so a caller can choose to refuse.
 *
 * `decoded` may be a codec result (`instruction`/`event`) or a union result
 * (`name`); both carry `absent`.
 */
export function describeShortForm(form, decoded, bytes) {
  const named = decoded.absent ?? [];
  const sameSet = named.length === form.absent.length
    && form.absent.every((field) => named.includes(field));
  const decodedName = decoded.name
    ?? (decoded.kind === 'event' ? decoded.event : decoded.instruction);
  return {
    // Verified means: THIS decode named exactly the fields the chain witness
    // saw missing, under the name the witness's log line carried. A decoder
    // that reports a different absence has not reproduced the measured form —
    // the IDL gained or lost a field since the witness was taken — and stale
    // evidence must not be spent on a shape nobody measured.
    verified: sameSet && (decodedName === undefined || decodedName === form.instruction),
    program: form.program,
    discriminator: form.discriminator,
    bytes: form.bytes,
    instruction: form.instruction,
    absent: form.absent,
    decodeAbsence: named,
    decodedName,
    witnesses: form.witnesses,
    source: SHORT_FORM_SOURCE,
    wireBytes: bytes.length,
  };
}
