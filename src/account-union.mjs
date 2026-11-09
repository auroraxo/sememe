// Union arbitration for ACCOUNT bytes: two verified interface sources, one
// account, and the disagreement made explicit instead of picked by preference.
//
// Why this exists (2026-11-08): instructions and events have had union decode
// since v0.4.0 — `sememe decode --union` reads the on-chain pull and the
// adopted first-party published copy, reports which one answered, and lets
// byte evidence decide. Accounts never got that half. `sememe account` read
// exactly ONE receipt (findStoredIdl, the newest), so a store holding two
// verified copies of a program had two opinions about an account's layout and
// only one of them was ever consulted — the README named this as the open
// item ("the same arbitration for account decoding (accounts still read a
// single receipt)").
//
// The measured case that made it concrete (2026-11-08, 12 real mainnet
// pump.fun accounts, research/account-union-2026-11-08.json): the program's
// on-chain IDL copy describes `BondingCurve` with 13 fields, the published
// copy with 19. A live 166-byte BondingCurve account decodes under the
// on-chain copy as 125 consumed + 41 unexplained bytes (partial answer), and
// under the published copy as a full byte-exact round trip. The plain path
// reported the partial one; the copy that explains every byte sat in the same
// store unread.
//
// The rules are the instruction union's rules, translated to accounts:
//
//   - Both sources refuse            -> refusal naming BOTH reasons.
//   - One refuses, the other decodes -> admitted ONLY when the survivor
//     reproduces its own bytes (full round trip, or the described prefix with
//     the rest reported as trailing). A source that names an account it cannot
//     re-encode is refused exactly like a first source would be.
//   - Both decode under DIFFERENT account names for the same 8 bytes
//     -> hard refusal (`name_conflict`): two schemas for one discriminator is
//     an interface conflict, and guessing which one to believe would launder it.
//   - Both decode the same name to the same args -> `agree`.
//   - Same name, different args -> `layout_drift`; the winner is chosen by
//     byte evidence, strongest first: a source whose re-encode reproduces the
//     WHOLE account body beats one that only reproduces a described prefix,
//     and between two prefix-only answers the one with FEWER unexplained
//     bytes explains strictly more of the account. When the evidence does not
//     decide, the PRIMARY (the on-chain pull, whenever one exists) stands and
//     the drift is reported — never resolved by preference.
//
// Nothing here mutates a source. Account discriminators are filled per source
// with Anchor's own rule before comparison (src/account.mjs); a stored value
// always wins and a conflict is recorded, never overwritten.

import { decodeAccountData, withDerivedAccountDiscriminators, identifyAccount } from './account.mjs';
import { toJsonSafe } from './codec.mjs';
import { UnionRefusal } from './union.mjs';

const reasonOf = (error) => String(error?.message ?? error).slice(0, 200);

/** Field paths where two decoded account trees disagree (bounded, stable). */
export function diffAccountPaths(primaryArgs, secondaryArgs) {
  const paths = [];
  const MAX = 20;
  const walk = (a, b, path) => {
    if (paths.length >= MAX) return;
    const aIsObj = a !== null && typeof a === 'object';
    const bIsObj = b !== null && typeof b === 'object';
    if (!aIsObj || !bIsObj) {
      if (JSON.stringify(a) !== JSON.stringify(b)) paths.push(path || '(root)');
      return;
    }
    if (Array.isArray(a) !== Array.isArray(b)) { paths.push(path || '(root)'); return; }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (paths.length >= MAX) return;
      walk(a[key], b[key], path ? `${path}.${key}` : key);
    }
  };
  walk(primaryArgs, secondaryArgs, '');
  return { paths, truncated: paths.length >= MAX };
}

/** One source's account probe: identify the type in THIS source's table, then
 *  decode and re-encode under THIS source's layout. Every fact stays
 *  per-source — a trailing count or a round-trip flag from one copy must never
 *  be attached to the other copy's answer. */
function probeAccount(source, bytes, forcedName) {
  try {
    const identified = forcedName ? { name: forcedName } : identifyAccount(source.idl, bytes);
    if (!identified) {
      return {
        ok: false,
        reason: `no account type in this source matches the first 8 bytes `
          + `(${bytes.subarray(0, 8).toString('hex')})`,
      };
    }
    const decoded = decodeAccountData(source.idl, bytes, identified.name, { trailing: 'report' });
    return {
      ok: true,
      decoded,
      fullExact: decoded.roundTripByteExact,
      describedExact: decoded.describedRoundTripByteExact,
      // Provenance of the discriminator that matched, kept PER SOURCE: a
      // stored value is bytes the program wrote on chain, a derived one is
      // Anchor's rule filling a gap. Reporting one source's derivation under
      // the other source's label would be exactly the drift this module exists
      // to make visible.
      discriminatorSource: source.discriminatorDerivation.filledAccounts > 0
        ? (source.discriminatorDerivation.conflicts > 0 ? 'stored+derived' : 'derived')
        : 'stored',
      discriminatorDerivation: source.discriminatorDerivation,
    };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}

/** Fill discriminator gaps for this source only, keeping the source's identity. */
function prepareAccountSource(source) {
  const { idl, filled, conflicts } = withDerivedAccountDiscriminators(source.idl);
  // Which accounts carried a STORED discriminator before filling — the line
  // between "this copy derives its discriminator from the name" (so a renamed
  // copy can never match) and "this copy pins a value that disagrees with the
  // bytes" (a drifted copy). The rename diagnosis below must only claim the
  // first mechanism when it is the first mechanism.
  const storedAccountNames = new Set(
    (source.idl?.accounts ?? [])
      .filter((a) => Array.isArray(a?.discriminator) && a.discriminator.length === 8)
      .map((a) => a.name),
  );
  return {
    ...source,
    idl,
    storedAccountNames,
    discriminatorDerivation: { filledAccounts: filled, conflicts: conflicts.length },
  };
}

/**
 * The refusing copy may well KNOW this account — under a different spelling.
 * Anchor derives an account discriminator from the EXACT name, so a copy that
 * spells it `vault` instead of `Vault` derives a different 8 bytes and can
 * never identify the deployed account, no matter how good its layout is.
 * Reporting that as "no account type matches these bytes" is true of the
 * discriminator but hides the mechanism from the user, who then cannot tell a
 * missing account from a RENAMED one (measured on 12 real meteora-vault
 * accounts, research/account-union-cross-2026-11-08.json).
 *
 * Called only when the OTHER source identified these bytes: a name is what
 * makes the comparison possible. Two sources that both fail tell us nothing
 * about each other (see the R3 control).
 */
function diagnoseRename(failedProbe, failedSource, bytes, otherName) {
  if (!otherName) return null;
  const accounts = failedSource.idl?.accounts ?? [];
  const variant = accounts.find((a) => typeof a?.name === 'string'
    && a.name !== otherName
    && a.name.toLowerCase() === otherName.toLowerCase());
  if (!variant) return null;
  const head = bytes.subarray(0, 8).toString('hex');
  const declared = Buffer.from(variant.discriminator ?? []).toString('hex');
  if (failedSource.storedAccountNames?.has(variant.name)) {
    // A stored value that disagrees is a different phenomenon (drift), not a
    // rename: say that instead of blaming the derivation.
    failedProbe.reason += `; this copy DOES declare the account, as "${variant.name}", with stored `
      + `discriminator ${declared} which does not match these bytes (${head}) — the other copy `
      + `identifies them as "${otherName}"`;
    return variant.name;
  }
  failedProbe.reason += `; this copy DOES declare the account, as "${variant.name}" — but Anchor `
    + `derives an account discriminator from the exact name, so "${variant.name}" derives `
    + `${declared} and these bytes carry ${head} (the other copy identifies them as "${otherName}")`;
  return variant.name;
}

/**
 * Format one field's declared type as the reader sees it in the IDL, so two
 * copies' declarations can be compared line by line (`publicKey[30]`, `u64`,
 * `VaultBumps`, `struct{4}`).
 */
function formatFieldType(type, depth = 0) {
  if (typeof type === 'string') return type;
  if (depth > 6) return '…';
  if (Array.isArray(type)) return type.map((t) => formatFieldType(t, depth + 1)).join(', ');
  if (type && typeof type === 'object') {
    if (Array.isArray(type.array)) return `${formatFieldType(type.array[0], depth + 1)}[${type.array[1]}]`;
    if (type.vec !== undefined) return `${formatFieldType(type.vec, depth + 1)}[]`;
    if (type.option !== undefined) return `${formatFieldType(type.option, depth + 1)}?`;
    if (type.defined !== undefined) {
      return typeof type.defined === 'string' ? type.defined : (type.defined?.name ?? JSON.stringify(type.defined));
    }
    if (Array.isArray(type.fields)) return `struct{${type.fields.length}}`;
    if (type.kind) return `${type.kind}`;
  }
  return JSON.stringify(type);
}

/** The declared field list of one account type in one copy (inline or types). */
function declaredFields(idl, accountName) {
  const account = (idl?.accounts ?? []).find((a) => a?.name === accountName);
  const inline = account?.type && typeof account.type === 'object' ? account.type : null;
  const typedef = (idl?.types ?? []).find((t) => t?.name === accountName);
  const type = inline ?? (typedef?.type ?? null);
  if (!type || !Array.isArray(type.fields)) return null;
  return type.fields;
}

/**
 * Compare two copies' DECLARED layout for the same account — nothing is
 * decoded, no byte decides anything here.
 *
 * This is the fact the rename diagnosis could see but not state: a copy that
 * can never identify the deployed bytes may still declare a different layout
 * for them. Reporting it keeps the verdict `primary_only` (the report is not
 * evidence) while telling the reader that the answer they got is contested
 * field by field. Measured on 12 meteora-vault accounts: 30 keys vs 29 keys
 * plus `version`, `totalLpSupply`, `padding0` — 960 bytes either way.
 *
 * Fields are paired by NORMALISED spelling so that a pure rename
 * (`totalAmount` vs `total_amount`) is not reported as a layout difference;
 * a field only one copy declares, or one both declare with different types,
 * is.
 */
function diffDeclaredLayout(primaryIdl, primaryName, secondaryIdl, secondaryName) {
  const primaryFields = declaredFields(primaryIdl, primaryName);
  const secondaryFields = declaredFields(secondaryIdl, secondaryName);
  if (!primaryFields || !secondaryFields) return null;

  const normalise = (key) => String(key).replace(/^_+/, '')
    .replace(/_+([a-z0-9])/g, (m, c) => c.toUpperCase());
  const present = (field) => `${formatFieldType(field.type)}`;

  const secondaryByNorm = new Map(secondaryFields.map((f) => [normalise(f.name), f]));
  const matchedNorm = new Set();
  const diffs = [];

  for (const field of primaryFields) {
    const key = normalise(field.name);
    const other = secondaryByNorm.get(key);
    if (!other) {
      diffs.push({ path: field.name, primary: present(field), secondary: null });
      continue;
    }
    matchedNorm.add(key);
    if (present(field) !== present(other)) {
      diffs.push({ path: field.name, primary: present(field), secondary: present(other) });
    }
  }
  for (const field of secondaryFields) {
    if (matchedNorm.has(normalise(field.name))) continue; // paired above
    diffs.push({ path: field.name, primary: null, secondary: present(field) });
  }

  return {
    primary: { account: primaryName, fields: primaryFields.length },
    secondary: { account: secondaryName, fields: secondaryFields.length },
    differs: diffs.length > 0,
    diffs,
  };
}

function accountView(source, probeResult) {
  if (probeResult === null) return { label: source?.label ?? null, present: false };
  return {
    label: source.label,
    present: true,
    fingerprint: source.idlMeta?.fingerprint ?? null,
    receipt: source.idlMeta?.receipt ?? null,
    decoded: probeResult.ok,
    refusedReason: probeResult.ok ? undefined : probeResult.reason,
    name: probeResult.ok ? probeResult.decoded.name : undefined,
    // Which byte evidence THIS source produced: every byte, the described
    // prefix only, or neither. The arbitration below reads these three.
    evidence: probeResult.ok
      ? (probeResult.fullExact ? 'full_roundtrip'
        : (probeResult.describedExact ? 'described_roundtrip' : 'none'))
      : undefined,
    roundTripByteExact: probeResult.ok ? probeResult.fullExact : undefined,
    describedRoundTripByteExact: probeResult.ok ? probeResult.describedExact : undefined,
    consumed: probeResult.ok ? probeResult.decoded.consumed : undefined,
    trailingBytes: probeResult.ok ? probeResult.decoded.trailing.count : undefined,
  };
}

function accountEnvelope(program, fields, winnerSource, view) {
  return {
    program,
    ...fields,
    idl: winnerSource.idlMeta,
    object: winnerSource.objectPath,
    view,
  };
}

function accountFields(probe, bytes) {
  const decoded = probe.decoded;
  return {
    kind: 'account',
    account: decoded.name,
    name: decoded.name,
    args: toJsonSafe(decoded.args),
    discriminator: decoded.discriminator,
    discriminatorMatches: decoded.hasDiscriminator,
    bytes: decoded.total,
    consumed: decoded.consumed,
    trailing: decoded.trailing,
    roundTripByteExact: decoded.roundTripByteExact,
    describedRoundTripByteExact: decoded.describedRoundTripByteExact,
    describedBytes: decoded.consumed,
    discriminatorSource: probe.discriminatorSource,
    discriminatorDerivation: probe.discriminatorDerivation,
  };
}

/**
 * Decode one account's bytes against a primary and an optional secondary
 * verified interface source.
 *
 * Sources are `{ label, idl, idlMeta, objectPath }` and must already be
 * store-verified (receipt re-hash etc.) — this module arbitrates, it does not
 * re-verify. `forcedName` skips identification for callers that already know
 * the account type; when given, both sources decode THAT name, so a name
 * conflict is impossible by construction and the verdict can never be a
 * coin flip over identification.
 *
 * @throws {UnionRefusal} for 'name_conflict', a fallback without byte
 *   evidence, and total refusal — carrying `details.view`, so the caller
 *   gets BOTH sources' verdicts in the failure.
 */
export function unionAccountDecode({ program, primary, secondary, bytes, name: forcedName, trailing, additional = [] }) {
  const soleSource = !primary?.idl && secondary?.idl ? secondary : null;
  if (!primary?.idl && !soleSource) {
    throw new UnionRefusal('invalid_input', 'unionAccountDecode needs a primary source');
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new UnionRefusal('invalid_input', 'unionAccountDecode needs the account bytes as a Buffer');
  }
  bytes = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (trailing !== undefined && trailing !== 'report' && trailing !== 'error') {
    throw new UnionRefusal('invalid_input', `unknown trailing policy ${JSON.stringify(trailing)}`);
  }

  const prim = prepareAccountSource(soleSource ?? primary);
  const sec = secondary?.idl && secondary !== soleSource ? prepareAccountSource(secondary) : null;
  const primAdopted = prim.idlMeta?.slot === null || prim.idlMeta?.slot === undefined;
  const secAdopted = !sec || sec.idlMeta?.slot === null || sec.idlMeta?.slot === undefined;
  const adoptedOnly = primAdopted && secAdopted;

  const primProbe = probeAccount(prim, bytes, forcedName);
  const secProbe = sec ? probeAccount(sec, bytes, forcedName) : null;

  // A refusal that is really a RENAME must say so (see diagnoseRename): only
  // when the other side identified the bytes do we have a name to compare with.
  // The rename also tells us WHICH account the other copy declares — and that
  // copy may declare a DIFFERENT LAYOUT for it (see diffDeclaredLayout). The
  // report is NOT evidence and never enters the arbitration: it only tells the
  // reader that the answer they got is contested, field by field.
  let renamedTo = null;
  if (primProbe.ok && secProbe && !secProbe.ok) {
    renamedTo = diagnoseRename(secProbe, sec, bytes, primProbe.decoded.name);
  } else if (secProbe?.ok && !primProbe.ok) {
    renamedTo = diagnoseRename(primProbe, prim, bytes, secProbe.decoded.name);
  }

  const view = {
    primary: accountView(prim, primProbe),
    secondary: accountView(sec, secProbe),
    sourcesAgree: null,
    adoptedOnly,
    additionalSources: additional.map((a) => ({
      label: a.label,
      fingerprint: a.idlMeta?.fingerprint,
      receipt: a.idlMeta?.receipt,
    })),
  };

  // The layout the OTHER copy declares for the account it could not identify
  // — a report, never evidence: `primary_only`/`fallback_secondary` still stand
  // exactly as the byte arbitration decides them below.
  if (renamedTo) {
    const primaryName = primProbe.ok ? primProbe.decoded.name : renamedTo;
    const secondaryName = secProbe?.ok ? secProbe.decoded.name : renamedTo;
    const declared = diffDeclaredLayout(prim.idl, primaryName, sec.idl, secondaryName);
    if (declared) view.declaredLayout = declared;
  }

  const finish = (winner, probe, verdict, basis, evidence) => {
    const fields = accountFields(probe, bytes);
    if (trailing === 'error' && fields.trailing.count > 0) {
      throw new UnionRefusal('trailing',
        `account carries ${fields.trailing.count} byte(s) after the structure `
        + `${winner.label} describes`,
        { view });
    }
    view.verdict = verdict;
    view.arbitration = { winner: winner.label, basis, evidence };
    return accountEnvelope(program, fields, winner, view);
  };

  // Single source: behave like a plain decode, but say which verdict it is.
  if (!sec) {
    if (!primProbe.ok) {
      throw new UnionRefusal('refused',
        `decode refused by the only stored source (${prim.label}): ${primProbe.reason}`,
        { view });
    }
    view.adoptedOnly = adoptedOnly;
    return finish(prim, primProbe, 'single_source', 'only_source',
      primProbe.fullExact ? 'full_roundtrip' : 'described_roundtrip');
  }

  view.discriminatorDerivation = {
    primary: prim.discriminatorDerivation,
    secondary: sec.discriminatorDerivation,
  };

  // Both refuse: name both reasons, never one of them.
  if (!primProbe.ok && !secProbe.ok) {
    throw new UnionRefusal('refused',
      `both stored sources refuse this account — ${prim.label}: ${primProbe.reason}; `
      + `${sec.label}: ${secProbe.reason}`,
      { view });
  }

  // Primary refuses, secondary decodes: byte evidence admits the fallback.
  if (!primProbe.ok && secProbe.ok) {
    if (!secProbe.fullExact && !secProbe.describedExact) {
      throw new UnionRefusal('union_fallback_refused',
        `${prim.label} refuses (${primProbe.reason}); ${sec.label} names `
        + `"${secProbe.decoded.name}" but cannot re-encode these bytes, so the fallback is refused`,
        { view });
    }
    view.sourcesAgree = false;
    return finish(sec, secProbe, 'fallback_secondary', 'primary_refused',
      secProbe.fullExact ? 'full_roundtrip' : 'described_roundtrip');
  }

  // Secondary refuses, primary decodes: the plain answer, with the refusal kept.
  if (primProbe.ok && !secProbe.ok) {
    view.sourcesAgree = false;
    return finish(prim, primProbe, 'primary_only', 'secondary_refused',
      primProbe.fullExact ? 'full_roundtrip' : 'described_roundtrip');
  }

  // Both decode. Same 8 bytes matched by two sources -> the NAMES must agree.
  if (primProbe.decoded.name !== secProbe.decoded.name) {
    throw new UnionRefusal('name_conflict',
      `interface conflict on the same account bytes: ${prim.label} says `
      + `"${primProbe.decoded.name}", ${sec.label} says "${secProbe.decoded.name}" — `
      + `refusing instead of picking a winner`,
      { view: { ...view, primary: { ...view.primary, name: primProbe.decoded.name }, secondary: { ...view.secondary, name: secProbe.decoded.name } } });
  }

  const primFields = accountFields(primProbe, bytes);
  const secFields = accountFields(secProbe, bytes);
  const argsAgree = JSON.stringify(primFields.args) === JSON.stringify(secFields.args);

  // Arbitration by bytes, strongest evidence first (see the header).
  let winner = prim;
  let basis = 'primary_by_default';
  let evidence = primProbe.fullExact ? 'full_roundtrip'
    : (primProbe.describedExact ? 'described_roundtrip' : 'none');
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
  } else if (primProbe.fullExact && secProbe.fullExact && !argsAgree) {
    // Both reproduce every byte yet describe different values: the evidence
    // genuinely does not decide (two layouts can serialise to the same bytes).
    basis = 'primary_by_default_evidence_tied';
    evidence = 'both_full_roundtrip';
  }

  view.sourcesAgree = argsAgree;
  if (!argsAgree) {
    view.verdict = 'layout_drift';
    view.drift = {
      ...diffAccountPaths(primFields.args, secFields.args),
      primaryExplainsFully: primProbe.fullExact,
      secondaryExplainsFully: secProbe.fullExact,
      primaryTrailingBytes: primTrailing,
      secondaryTrailingBytes: secTrailing,
      note: 'both sources decoded the same account bytes to different values; '
        + 'the winner was chosen by byte evidence where it decides, otherwise the primary stands '
        + 'and the drift is reported',
    };
  } else {
    view.verdict = 'agree';
  }
  view.arbitration = { winner: winner.label, basis, evidence };
  if (trailing === 'error') {
    const winnerProbe = winner === prim ? primProbe : secProbe;
    const fields = accountFields(winnerProbe, bytes);
    if (fields.trailing.count > 0) {
      throw new UnionRefusal('trailing',
        `account carries ${fields.trailing.count} byte(s) after the structure ${winner.label} describes`,
        { view });
    }
  }
  const fields = winner === prim ? primFields : secFields;
  return accountEnvelope(program, fields, winner, view);
}

export { UnionRefusal } from './union.mjs';
