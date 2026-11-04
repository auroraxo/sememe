// Union decode: one payload against TWO verified interface sources, with the
// disagreement made explicit and arbitrated by bytes, not by preference.
//
// Why this exists: the pump.fun measurement (research/traffic-coverage-2026-10-30.json)
// showed that a deployed program's own on-chain IDL account and its first-party
// published copy DISAGREE about real mainnet traffic — 996 payloads, same window:
//   on-chain alone      669/996 decoded
//   published alone     880/996 decoded
//   union of both       914/996 decoded
// The union there was a hand-merged IDL inside a measurement tool. This module is
// the product form of that result: both sources stay intact, every decode names
// which source produced it, and the two sources must answer the same question:
//
//   - Both decode to the SAME name and args  -> 'agree'
//   - Both decode, same name, different args -> 'layout_drift'; the winner is
//     chosen by byte evidence: the source whose re-encode reproduces the WHOLE
//     payload explains the bytes the other only prefixes (measured: the
//     published `partial_fill` argument on `buy`-family instructions — real
//     long-form payloads leave 1 unexplained byte under the on-chain layout).
//     When both or neither explain fully, the primary wins and the drift is
//     reported, not hidden.
//   - One refuses, the other decodes        -> 'fallback_secondary' — but ONLY
//     if the surviving decode re-encodes to the actual bytes (full or
//     described prefix). A second source that names bytes it cannot reproduce
//     is refused, exactly like a first source would be.
//   - Names differ on the same discriminator -> hard refusal. Two different
//     names for the same bytes is an interface conflict, not a decode: guessing
//     either one would launder it.
//   - Both refuse                           -> refusal with BOTH named reasons.
//
// Nothing here mutates either source. Discriminator gaps are filled per source
// with Anchor's rule (src/discriminators.mjs) before decoding, so two legacy
// sources can be compared at all; stored discriminators are never touched.

import { decodeData, encodeInstructionData, encodeEventData, toJsonSafe } from './codec.mjs';
import { withDerivedDiscriminators, snakeCase, globalDiscriminator } from './discriminators.mjs';

const MAX_DIFF_PATHS = 20;

/** Named refusal carrying the verdict, so callers can tally without parsing text. */
export class UnionRefusal extends Error {
  constructor(verdict, message, details) {
    super(message);
    this.name = 'UnionRefusal';
    this.verdict = verdict;
    this.details = details ?? {};
  }
}

const reasonOf = (error) => String(error?.message ?? error).slice(0, 200);

/**
 * Decode + re-encode under one source's own layout; every fact stays per-source.
 *
 * `absentPolicy` is passed through to the decoder. With 'report' a source that
 * declares one field more than the wire carries can still decode — and then
 * the re-encode MUST omit exactly the fields the decode reported absent, or
 * the bytes would not reproduce and the decode would look like a guess. The
 * absent list therefore travels from decode to re-encode: byte-exactness is
 * what makes an absent field honest instead of invented.
 */
function probe(source, bytes, absentPolicy) {
  try {
    const decoded = decodeData(source.idl, bytes, { trailing: 'report', absent: absentPolicy });
    const reencoded = decoded.kind === 'instruction'
      ? encodeInstructionData(source.idl, decoded.instruction, decoded.args, { absent: decoded.absent })
      : encodeEventData(source.idl, decoded.event, decoded.args, { tagged: decoded.tagged });
    const described = bytes.subarray(0, decoded.consumed);
    return {
      ok: true,
      decoded,
      fullExact: reencoded.equals(bytes),
      describedExact: reencoded.equals(described),
    };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}

/** Prepare one caller-verified IDL: fill discriminator gaps per source, keep counts.
 * The source's identity (`idlMeta`, `objectPath`) rides along so the winning
 * side's provenance can be quoted in the result. */
function prepare(source) {
  const { idl: filledIdl, filled, conflicts } = withDerivedDiscriminators(source.idl);
  // The STORED discriminators, kept per instruction name: a rename is
  // recognized by the bytes, not by a name similarity — see the rename check
  // in unionDecode.
  const stored = new Map();
  for (const ix of source.idl?.instructions ?? []) {
    if (ix && typeof ix.name === 'string' && Array.isArray(ix.discriminator) && ix.discriminator.length === 8) {
      stored.set(ix.name, Buffer.from(ix.discriminator).toString('hex'));
    }
  }
  return {
    ...source,
    idl: filledIdl,
    storedDiscriminators: stored,
    discriminatorDerivation: {
      filledInstructions: filled.instructions,
      filledEvents: filled.events,
      conflicts: conflicts.length,
    },
  };
}

/** Field paths where two decoded arg trees disagree (bounded, stable order). */
function diffPaths(primaryArgs, secondaryArgs) {
  const paths = [];
  const walk = (a, b, path) => {
    if (paths.length >= MAX_DIFF_PATHS) return;
    const aIsObj = a !== null && typeof a === 'object';
    const bIsObj = b !== null && typeof b === 'object';
    if (!aIsObj || !bIsObj) {
      if (JSON.stringify(a) !== JSON.stringify(b)) paths.push(path || '(root)');
      return;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
      paths.push(path || '(root)');
      return;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (paths.length >= MAX_DIFF_PATHS) return;
      walk(a[key], b[key], path ? `${path}.${key}` : key);
    }
  };
  walk(primaryArgs, secondaryArgs, '');
  return { paths, truncated: paths.length >= MAX_DIFF_PATHS };
}

function decodeFields(source, probeResult, bytes) {
  const { decoded } = probeResult;
  const described = bytes.subarray(0, decoded.consumed);
  return {
    kind: decoded.kind,
    instruction: decoded.kind === 'instruction' ? decoded.instruction : undefined,
    event: decoded.kind === 'event' ? decoded.event : undefined,
    name: decoded.kind === 'instruction' ? decoded.instruction : decoded.event,
    discriminator: decoded.discriminator,
    tagged: decoded.tagged,
    args: toJsonSafe(decoded.args),
    // Declared fields this source's layout does not carry in these bytes.
    // Non-empty means the wire is SHORTER than the interface says — the
    // caller can see that instead of having to infer it from missing keys.
    absent: decoded.absent ?? [],
    bytes: bytes.length,
    consumed: decoded.consumed,
    trailing: decoded.trailing,
    roundTripByteExact: probeResult.fullExact,
    describedRoundTripByteExact: probeResult.describedExact,
    describedBytes: described.length,
  };
}

function resultEnvelope(program, fields, winnerSource, view) {
  return {
    program,
    ...fields,
    // Provenance of the decode: WHICH verified source produced the answer, and
    // what the OTHER source said. `idl` describes the winning source only.
    idl: winnerSource.idlMeta,
    object: winnerSource.objectPath,
    view,
  };
}

/**
 * Decode `bytes` against a primary and an optional secondary interface source.
 *
 * Both IDLs must already be store-verified by the caller (receipt re-hash etc.)
 * — this module deliberately does not re-verify, it arbitrates. Sources are
 * `{ label, idl, idlMeta, objectPath }`; `idlMeta` is quoted verbatim in the
 * result's `idl` field (fingerprint/slot/source/receipt of the winning side).
 *
 * Returns the decoded result on 'agree' | 'layout_drift' | 'fallback_secondary'
 * | 'single_source'; throws `UnionRefusal` for 'name_conflict', a secondary
 * fallback without byte evidence, and total refusal.
 */
export function unionDecode({ program, primary, secondary, bytes, absent }) {
  // An adopted copy is a VERIFIED source like any other: it may stand alone
  // when there is no on-chain pull to sit next to. The acquisition gap
  // (a program with no pullable IDL account — measured for Jupiter Liquidity
  // and Raydium AMM v4 in the traffic sample) produced stores that hold a
  // published copy and nothing else; refusing those with "needs a primary
  // source" reported "no interface" about a store that has one, and made the
  // union flag disagree with the plain decode on the same bytes.
  // What an adopted copy must NEVER do is DISPLACE an on-chain pull: that is
  // still the primary whenever one exists.
  const soleSource = !primary?.idl && secondary?.idl ? secondary : null;
  if (!primary?.idl && !soleSource) throw new UnionRefusal('invalid_input', 'unionDecode needs a primary source');
  if (!Buffer.isBuffer(bytes)) throw new UnionRefusal('invalid_input', 'unionDecode needs the payload bytes as a Buffer');
  // 'error' is the default and keeps the whole product strict. 'report' is the
  // opt-in that lets a source decode a wire form SHORTER than its own layout
  // declares — measured as chain-accepted on mainnet (research/
  // short-form-wire-forms-2026-11-03.json).
  const absentPolicy = absent ?? 'error';
  if (absentPolicy !== 'report' && absentPolicy !== 'error') {
    throw new UnionRefusal('invalid_input', `unknown absent policy ${JSON.stringify(absent)}`);
  }
  const prim = prepare(soleSource ?? primary);
  const sec = secondary?.idl && secondary !== soleSource ? prepare(secondary) : null;

  const primProbe = probe(prim, bytes, absentPolicy);
  const secProbe = sec ? probe(sec, bytes, absentPolicy) : null;

  const sourceView = (source, probeResult) => probeResult === null
    ? { label: source?.label ?? null, present: false }
    : {
      label: source.label,
      present: true,
      decoded: probeResult.ok,
      refusedReason: probeResult.ok ? undefined : probeResult.reason,
      name: probeResult.ok ? probeResult.decoded.kind === 'instruction'
        ? probeResult.decoded.instruction : probeResult.decoded.event : undefined,
      roundTripByteExact: probeResult.ok ? probeResult.fullExact : undefined,
      describedRoundTripByteExact: probeResult.ok ? probeResult.describedExact : undefined,
      trailingBytes: probeResult.ok ? probeResult.decoded.trailing.count : undefined,
      absentFields: probeResult.ok ? (probeResult.decoded.absent ?? []).length : undefined,
    };

  const view = {
    primary: sourceView(prim, primProbe),
    secondary: sourceView(sec, secProbe),
    sourcesAgree: null,
  };

  // Single source: behave like a plain decode, but say so.
  if (!sec) {
    if (!primProbe.ok) {
      throw new UnionRefusal('refused',
        `decode refused by the only stored source (${prim.label}): ${primProbe.reason}`,
        { view });
    }
    const fields = decodeFields(prim, primProbe, bytes);
    view.verdict = 'single_source';
    view.adoptedOnly = Boolean(soleSource);
    view.arbitration = { winner: prim.label, basis: 'only_source', evidence: primProbe.fullExact ? 'full_roundtrip' : 'described_roundtrip' };
    return resultEnvelope(program, fields, prim, view);
  }

  view.discriminatorDerivation = { primary: prim.discriminatorDerivation, secondary: sec.discriminatorDerivation };

  // Both refuse: the payload is refused, with both named reasons visible.
  if (!primProbe.ok && !secProbe.ok) {
    throw new UnionRefusal('refused',
      `both stored sources refuse this payload — ${prim.label}: ${primProbe.reason}; ${sec.label}: ${secProbe.reason}`,
      { view });
  }

  // Primary refuses, secondary decodes: only byte evidence admits the fallback.
  if (!primProbe.ok && secProbe.ok) {
    if (!secProbe.fullExact && !secProbe.describedExact) {
      throw new UnionRefusal('union_fallback_refused',
        `${prim.label} refuses (${primProbe.reason}); ${sec.label} names `
        + `"${secProbe.decoded.kind === 'instruction' ? secProbe.decoded.instruction : secProbe.decoded.event}" `
        + `but cannot re-encode the bytes, so the fallback is refused`,
        { view });
    }
    const fields = decodeFields(sec, secProbe, bytes);
    view.verdict = 'fallback_secondary';
    view.sourcesAgree = false;
    view.arbitration = {
      winner: sec.label,
      basis: 'primary_refused',
      evidence: secProbe.fullExact ? 'full_roundtrip' : 'described_roundtrip',
    };
    return resultEnvelope(program, fields, sec, view);
  }

  // Secondary refuses, primary decodes: plain primary decode, refusal recorded.
  if (primProbe.ok && !secProbe.ok) {
    const fields = decodeFields(prim, primProbe, bytes);
    view.verdict = 'primary_only';
    view.sourcesAgree = false;
    view.arbitration = {
      winner: prim.label,
      basis: 'secondary_refused',
      evidence: primProbe.fullExact ? 'full_roundtrip' : 'described_roundtrip',
    };
    return resultEnvelope(program, fields, prim, view);
  }

  // Both decode. Same discriminator matched by both sources (decodeData works
  // on discriminators), so the NAMES must agree — two different names for the
  // same bytes is an interface conflict, not a decode.
  const primFields = decodeFields(prim, primProbe, bytes);
  const secFields = decodeFields(sec, secProbe, bytes);
  //
  // Measured exception (2026-11-04, step-ingestooor sweep, 31 payloads across
  // hubble/dca/farms/vaults/perps/marginfi/tuna/referrals): Anchor's own rule
  // derives the INSTRUCTION discriminator from the snake-cased name
  // (sha256("global:" + snake_case(name))[0..8]), so two sources that matched
  // the same 8 bytes and differ only in naming CONVENTION (`closeDca` vs
  // `close_dca`, `repayLoan` vs `repay_loan`) are describing ONE wire
  // instruction — refusing it would refuse real, successfully executed
  // traffic over a spelling difference. That case is DECODED, the convention
  // difference recorded under `view.namingConvention`, the on-chain name kept
  // as the answer. EVENTS stay strict: their discriminator hashes the raw
  // name (no snake_case), so two event names that differ at all are two
  // different claimed schemas for the same bytes.
  if (primFields.name !== secFields.name || primFields.kind !== secFields.kind) {
    const sameInstructionTwoConventions = primFields.kind === 'instruction'
      && secFields.kind === 'instruction'
      && snakeCase(primFields.name) === snakeCase(secFields.name);
    const storedDisc = (source, name) => source.storedDiscriminators?.get(name) ?? null;
    const ruleDisc = (name) => Buffer.from(globalDiscriminator(name)).toString('hex');
    const renamedByPrimary = storedDisc(prim, primFields.name) === ruleDisc(secFields.name);
    const renamedBySecondary = storedDisc(sec, secFields.name) === ruleDisc(primFields.name);
    // The convention check comes FIRST: for `closeDca` vs `close_dca` Anchor's
    // rule yields the same discriminator either way, so both the convention
    // and the rename test would match — but it is one instruction under two
    // spellings, not a rename, and the recorded `kind` must say so.
    const sameInstructionRenamed = !sameInstructionTwoConventions
      && primFields.kind === 'instruction'
      && secFields.kind === 'instruction'
      && (renamedByPrimary || renamedBySecondary);
    if (!sameInstructionTwoConventions && !sameInstructionRenamed) {
      throw new UnionRefusal('name_conflict',
        `interface conflict on the same bytes: ${prim.label} says "${primFields.name}", `
        + `${sec.label} says "${secFields.name}" — refusing instead of picking a winner`,
        { view: { ...view, primary: { ...view.primary, name: primFields.name }, secondary: { ...view.secondary, name: secFields.name } } });
    }
    view.namingConvention = {
      primary: primFields.name,
      secondary: secFields.name,
      kind: sameInstructionRenamed ? 'rename' : 'naming-convention',
      rule: sameInstructionRenamed
        ? "anchor: the primary's stored discriminator equals sha256('global:' + snake_case(secondary name))[0..8] — same wire instruction, renamed by the program; the on-chain name answers"
        : "anchor: sha256('global:' + snake_case(name))[0..8] — same instruction, two naming conventions; the on-chain name answers",
    };
  }

  // Arbitration by bytes, strongest evidence first:
  //   1. A source that re-encodes the WHOLE payload explains every byte.
  //   2. Otherwise, the source with FEWER unexplained trailing bytes explains
  //      strictly more of the same bytes (measured on pump.fun events: the
  //      on-chain TradeEvent copy declares 34 fields and leaves 16 bytes
  //      unexplained, the published copy declares the additional
  //      creator_fee_unclaimed: u64 and leaves 8; both still leave the known
  //      8-byte tail, so the disagreement stays REPORTED under `drift`).
  // When the evidence does not decide, the primary stands and the drift is
  // reported — never hidden, never resolved by preference.
  let winner = prim;
  let basis = 'primary_by_default';
  let evidence = primProbe.fullExact ? 'full_roundtrip' : (primProbe.describedExact ? 'described_roundtrip' : null);
  const primTrailing = primProbe.decoded.trailing.count;
  const secTrailing = secProbe.decoded.trailing.count;
  if (secProbe.fullExact && !primProbe.fullExact) {
    winner = sec;
    basis = 'byte_evidence_full_roundtrip';
    evidence = 'full_roundtrip';
  } else if (!primProbe.fullExact && !secProbe.fullExact
    && primProbe.describedExact && secProbe.describedExact
    && secTrailing < primTrailing) {
    winner = sec;
    basis = 'byte_evidence_fewer_unexplained_bytes';
    evidence = `trailing ${secTrailing} < ${primTrailing}`;
  }

  const argsAgree = JSON.stringify(primFields.args) === JSON.stringify(secFields.args);
  const fields = winner === prim ? primFields : secFields;
  view.sourcesAgree = argsAgree;
  view.arbitration = { winner: winner.label, basis, evidence };

  if (!argsAgree) {
    view.verdict = 'layout_drift';
    view.drift = {
      paths: diffPaths(primFields.args, secFields.args),
      primaryExplainsFully: primProbe.fullExact,
      secondaryExplainsFully: secProbe.fullExact,
      primaryTrailingBytes: primTrailing,
      secondaryTrailingBytes: secTrailing,
      note: 'both sources decoded the same bytes to different arguments; the winner was chosen by byte evidence where it decides, otherwise the primary stands and the drift is reported',
    };
  } else {
    view.verdict = 'agree';
  }
  return resultEnvelope(program, fields, winner, view);
}
