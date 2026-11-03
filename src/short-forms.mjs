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
// research/short-form-wire-forms-2026-11-03.json:
//
//   - the transaction's `err` field is null (the chain accepted it),
//   - the witness instruction bytes are byte-IDENTICAL to the fixture payload,
//   - the program's own log line names the instruction the decode will report.
//
// On this repo's unbiased 12,572-payload sample that resolved 171 of the 172
// refusals: 0 of them were genuine chain-rejected refusals. The table is the
// product form of that measurement — the evidence travels with the decoder, so
// `absent: 'verified'` can name these forms while still refusing every other
// payload that happens to end on a field boundary.
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
];

export const SHORT_FORM_SOURCE =
  'research/short-form-wire-forms-2026-11-03.json (chain witnesses: err:null, byte-identical payload, matching program log line)';

export const VERIFIED = VERIFIED_SHORT_FORMS;
export { VERIFIED_SHORT_FORMS };

/** Look up a payload in the chain-verified short-form table; null when absent. */
export function verifiedShortForm(program, data) {
  if (!program || !(data instanceof Uint8Array)) return null;
  if (data.length < 8) return null;
  const discriminator = Buffer.from(data.subarray(0, 8)).toString('hex');
  return VERIFIED_SHORT_FORMS.find((entry) =>
    entry.program === program
    && entry.discriminator === discriminator
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
