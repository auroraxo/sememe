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
import { withDerivedDiscriminators } from './discriminators.mjs';

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

/** Decode + re-encode under one source's own layout; every fact stays per-source. */
function probe(source, bytes) {
  try {
    const decoded = decodeData(source.idl, bytes, { trailing: 'report' });
    const reencoded = decoded.kind === 'instruction'
      ? encodeInstructionData(source.idl, decoded.instruction, decoded.args)
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
  return {
    ...source,
    idl: filledIdl,
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
export function unionDecode({ program, primary, secondary, bytes }) {
  if (!primary?.idl) throw new UnionRefusal('invalid_input', 'unionDecode needs a primary source');
  if (!Buffer.isBuffer(bytes)) throw new UnionRefusal('invalid_input', 'unionDecode needs the payload bytes as a Buffer');
  const prim = prepare(primary);
  const sec = secondary?.idl ? prepare(secondary) : null;

  const primProbe = probe(prim, bytes);
  const secProbe = sec ? probe(sec, bytes) : null;

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
  if (primFields.name !== secFields.name || primFields.kind !== secFields.kind) {
    throw new UnionRefusal('name_conflict',
      `interface conflict on the same bytes: ${prim.label} says "${primFields.name}", `
      + `${sec.label} says "${secFields.name}" — refusing instead of picking a winner`,
      { view: { ...view, primary: { ...view.primary, name: primFields.name }, secondary: { ...view.secondary, name: secFields.name } } });
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
