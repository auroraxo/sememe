// Account-list conformance: the DECLARED interface against the accounts a
// transaction actually passed.
//
// Why this file exists: everything else sememe verifies is BYTES. But a
// Solana instruction is bytes AND an account list, and the account list has
// its own defect class, measured on live mainnet traffic of a foreign
// first-party program (jup-ag order_engine, reported as
// jup-ag/rfq-webhook-toolkit#96): the published interface declared 11
// accounts while every observed `fill` carried 12 or 13 — and the extra
// account at the end SIGNS every fill and pays the fee in 31/141. A consumer
// that builds its signer/authority reasoning from the interface alone is
// blind to an account that signs.
//
// So this module answers one question, offline, from the same verified
// store the decoder uses:
//
//   Given an instruction of a stored IDL and the account list one
//   transaction passed to it, does the interface describe that list?
//
// Verdicts (ordered by severity, first match wins):
//   missing-declared-accounts   the wire carries FEWER accounts than the
//                               interface declares non-optional positions
//                               for. The program cannot have accepted it.
//   declared-signer-not-signing the interface says position k is a signer;
//                               the transaction does not have it signing.
//                               For a SUCCESSFUL transaction this is
//                               interface/wire disagreement, not a rule the
//                               program applied.
//   fixed-address-mismatch      the interface pins an address (e.g.
//                               system_program); the wire passed another.
//   undeclared-signing-account  the wire carries accounts beyond the
//                               declared list AND one of them signs: an
//                               authority the interface does not name. This
//                               is the finding class this file was built
//                               for.
//   unknown-instruction         the instruction name is not in the IDL.
//
// Informational, never a violation on their own:
//   remaining-accounts          extras beyond the declared list that do NOT
//                               sign — Anchor's remaining_accounts is a
//                               legitimate, very common pattern.
//   signer-at-non-signer-position  the interface does not declare a position
//                               as a signer but the account signed anyway
//                               (the fee payer sits in exactly this
//                               position often). Signing MORE than declared
//                               is harmless; signing LESS is not.
//
// Limits, stated with the code because they change what a verdict means:
//   - An observed position whose signer status cannot be determined (no
//     message header, mangled encoding) is recorded as `unknownSigner`
//     and never produces a signer verdict in either direction: absence of
//     evidence must not become evidence of absence.
//   - Optional accounts: Anchor's own wire shape keeps a placeholder for an
//     absent optional account, so a SHORT list whose missing tail is all
//     optional is reported as `short-optional-tail` (informational), not as
//     a missing-account violation. Which Anchor version a program was built
//     with is not in the IDL, so this stays a separate verdict rather than
//     being folded into `conforms`.
//   - Writable-flag mismatches are reported per position (`writableNotes`)
//     but never decide the verdict: the runtime grants/revokes permission
//     from the transaction, not from the IDL, so an IDL that disagrees
//     about writability is documentation drift, not an acceptance bug.
//   - This checks ONE instruction against ONE transaction. It does not
//     prove the program accepted anything (that is `txErr`, carried by the
//     caller), and it does not prove the interface is wrong rather than the
//     transaction: it names the disagreement.

/** The declared account list of an instruction, normalized from either IDL
 * spec (new: signer/writable/optional; legacy: isSigner/isMut/isOptional).
 * The optional flag is load-bearing for conformance: a declared-OPTIONAL
 * signer that arrives without a signature is the account being absent, not
 * a rule violation (measured on OpenBook v2's `cancelAllAndPlaceOrders`,
 * whose legacy IDL marks `openOrdersAdmin` isOptional+isSigner and whose
 * live traffic passes it unsigned whenever the admin is not needed). */
export function declaredAccounts(instruction) {
  if (!instruction || !Array.isArray(instruction.accounts)) return null;
  return instruction.accounts.map((entry, index) => ({
    index,
    name: entry?.name ?? null,
    signer: Boolean(entry?.signer ?? entry?.isSigner),
    writable: Boolean(entry?.writable ?? entry?.isMut),
    optional: Boolean(entry?.optional ?? entry?.isOptional),
    address: typeof entry?.address === 'string' ? entry.address : null,
  }));
}

/** Match payload bytes to an IDL instruction by its 8-byte discriminator
 * (stored or derived by Anchor's rule). Returns null when no instruction
 * carries these bytes. */
export function instructionByDiscriminator(idl, discriminatorBytes) {
  if (!idl || !Array.isArray(discriminatorBytes) || discriminatorBytes.length !== 8) return null;
  const instructions = idl.instructions ?? [];
  const match = instructions.find((entry) => {
    const stored = Array.isArray(entry?.discriminator) ? entry.discriminator : null;
    if (!stored || stored.length !== discriminatorBytes.length) return false;
    return stored.every((byte, index) => byte === discriminatorBytes[index]);
  });
  return match ?? null;
}

/**
 * Compare one instruction's declared account list with one observed list.
 *
 * @param {object}   instruction     IDL instruction (may be null -> unknown-instruction)
 * @param {Array}    observed        [{ address, signer?, writable? }] in wire
 *                                   order; `signer` true/false or absent.
 * * @param {object}   [options]
 * @param {string}   [options.program]  program id, echoed into the verdict
 * @param {string}   [options.programId] program id of the instruction — when a
 *                                   DECLARED OPTIONAL position carries this
 *                                   address, Anchor's convention marks the
 *                                   account as ABSENT (the None placeholder
 *                                   is the program's own id). An absent
 *                                   optional account is not a signer and not
 *                                   a disagreement.
 * @param {string}   [options.name]     instruction name if `instruction` is null
 * @param {boolean}  [options.executed] whether the transaction succeeded
 *                                   (meta.err == null). A failed transaction
 *                                   may have been rejected FOR one of these
 *                                   reasons; the verdict is tagged, not
 *                                   downgraded.
 * @param {number}   [options.depth]    instruction call depth (0 = top-level,
 *                                   >0 = CPI). At depth > 0 the signer flag of
 *                                   an account is NOT observable from the
 *                                   top-level message header: the account may
 *                                   be a PDA signed for inside the CPI stack
 *                                   via `invoke_signed`, which never appears in
 *                                   `numRequiredSignatures` (measured on
 *                                   Whirlpool swap_v2 invoked via CPI by the
 *                                   Titan router). Such a position is reported
 *                                   as an informational note, never as a
 *                                   signature violation; at depth 0 the header
 *                                   IS the authority and the check stands.
 */
export function checkAccountList(instruction, observed, options = {}) {
  const { program = null, programId = null, name = null, executed = null, depth = 0 } = options;
  const base = { program, instruction: instruction?.name ?? name ?? null, executed, positions: { declared: null, observed: observed?.length ?? 0 } };

  if (!instruction) {
    return { ...base, verdict: 'unknown-instruction', violations: [], extras: [], notes: [] };
  }
  const declared = declaredAccounts(instruction);
  if (!declared) {
    return { ...base, verdict: 'unknown-instruction', violations: [], extras: [], notes: [] };
  }

  const rows = observed ?? [];
  const violations = [];
  const notes = [];
  const unknownSigner = [];

  base.positions.declared = declared.length;
  base.positions.required = declared.filter((entry) => !entry.optional).length;

  // 1. Length: short lists, optional tails, extras.
  let extras = [];
  if (rows.length < declared.length) {
    const missing = declared.slice(rows.length);
    const missingNonOptional = missing.filter((entry) => !entry.optional);
    if (missingNonOptional.length) {
      violations.push({
        kind: 'missing-declared-accounts',
        missing: missing.map((entry) => ({ index: entry.index, name: entry.name, optional: entry.optional })),
      });
    } else {
      notes.push({
        kind: 'short-optional-tail',
        missing: missing.map((entry) => ({ index: entry.index, name: entry.name })),
      });
    }
  } else {
    extras = rows.slice(declared.length).map((entry, offset) => ({
      index: declared.length + offset,
      address: entry?.address ?? null,
      signer: entry?.signer ?? null,
      writable: entry?.writable ?? null,
    }));
  }

  // 2. Positional signer comparison over the declared range.
  const limit = Math.min(declared.length, rows.length);
  const writableNotes = [];
  const absentOptional = [];
  for (let index = 0; index < limit; index++) {
    const want = declared[index];
    const got = rows[index] ?? {};
    const signerKnown = got.signer === true || got.signer === false;

    // Anchor's absent-optional placeholder: the declared optional position
    // carries the program's own id, which means "None" — not "this account".
    // Comparing its signer flag would manufacture a violation out of the
    // convention that avoids one.
    //
    // A declared-OPTIONAL signer that arrives without a signature is ALSO an
    // absent optional account (Anchor lets the caller pass the program id or
    // any non-signing placeholder when the signer is optional and absent;
    // measured on OpenBook v2 `cancelAllAndPlaceOrders.openOrdersAdmin`).
    const placeholder = want.optional && (
      (programId && got.address === programId) || (want.signer && got.signer === false)
    );
    if (placeholder) {
      absentOptional.push({ index, name: want.name, signer: want.signer });
      continue;
    }

    if (!signerKnown) {
      unknownSigner.push({ index, name: want.name, declaredSigner: want.signer });
    } else if (want.signer && got.signer === false) {
      // At depth > 0 the signer flag cannot be resolved from the top-level
      // header: the declaring position may be a PDA signed inside the CPI
      // stack via `invoke_signed`, which never shows in
      // `numRequiredSignatures`. Treating it as a violation would be a false
      // positive from measuring the wrong boundary.
      if (depth > 0) {
        notes.push({
          kind: 'cpi-signer-not-observable',
          index, name: want.name, depth,
          reason: 'the top-level message header does not carry CPI signer authority (invoke_signed PDAs)',
        });
      } else {
        violations.push({
          kind: 'declared-signer-not-signing',
          index, name: want.name,
        });
      }
    } else if (!want.signer && got.signer === true) {
      notes.push({ kind: 'signer-at-non-signer-position', index, name: want.name });
    }

    if (want.address && got.address && want.address !== got.address) {
      violations.push({
        kind: 'fixed-address-mismatch',
        index, name: want.name, declared: want.address, observed: got.address,
      });
    }

    if (typeof got.writable === 'boolean' && got.writable !== want.writable) {
      writableNotes.push({ index, name: want.name, declaredWritable: want.writable, observedWritable: got.writable });
    }
  }

  // 3. The extras: signing extras are an authority the interface does not name.
  const signingExtras = extras.filter((entry) => entry.signer === true);
  if (signingExtras.length) {
    violations.push({
      kind: 'undeclared-signing-account',
      accounts: signingExtras,
      extraCount: extras.length,
    });
  } else if (extras.length) {
    notes.push({ kind: 'remaining-accounts', extraCount: extras.length, addresses: extras.map((entry) => entry.address) });
  }
  if (absentOptional.length) {
    notes.push({ kind: 'absent-optional-accounts', accounts: absentOptional });
  }

  const verdict = violations.length
    ? violations[0].kind
    : (notes.some((entry) => entry.kind === 'short-optional-tail') ? 'short-optional-tail'
      : (extras.length ? 'remaining-accounts' : 'conforms'));

  return {
    ...base,
    verdict,
    violations,
    extras,
    notes: [...notes, ...(writableNotes.length ? [{ kind: 'writable-disagreement', positions: writableNotes }] : [])],
    unknownSigner,
  };
}

/**
 * Aggregate a list of per-instruction verdicts into the report shape.
 * Pure: the live tool only collects rows, this derives every number in the
 * summary from them (a hand-edited summary cannot disagree with its rows).
 */
export function summarizeConformance(rows) {
  const summary = {
    instructions: rows.length,
    byVerdict: {},
    byProgram: {},
    byInstruction: {},
    executed: { total: 0, disagreements: 0 },
    unknownDiscriminator: 0,
    unknownSignerPositions: 0,
  };
  for (const row of rows) {
    summary.byVerdict[row.verdict] = (summary.byVerdict[row.verdict] ?? 0) + 1;
    if (row.verdict === 'unknown-discriminator') summary.unknownDiscriminator += 1;
    const program = row.program ?? '(unknown)';
    if (!summary.byProgram[program]) {
      summary.byProgram[program] = { instructions: 0, verdicts: {} };
    }
    summary.byProgram[program].instructions += 1;
    summary.byProgram[program].verdicts[row.verdict] = (summary.byProgram[program].verdicts[row.verdict] ?? 0) + 1;
    const name = row.instruction ?? '(none)';
    if (!summary.byInstruction[name]) summary.byInstruction[name] = { total: 0, verdicts: {} };
    summary.byInstruction[name].total += 1;
    summary.byInstruction[name].verdicts[row.verdict] = (summary.byInstruction[name].verdicts[row.verdict] ?? 0) + 1;
    if (row.executed === true || row.executed === false) {
      summary.executed.total += 1;
      const disagreeing = Array.isArray(row.violations) && row.violations.length > 0;
      if (disagreeing) summary.executed.disagreements += 1;
    }
    summary.unknownSignerPositions += Array.isArray(row.unknownSigner) ? row.unknownSigner.length : 0;
  }
  return summary;
}
