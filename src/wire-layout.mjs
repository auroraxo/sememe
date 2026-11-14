// Count-from-header: an evidence-gated rule for a vector whose element count
// the wire carries in an instruction HEADER field, not as a Borsh length
// prefix.
//
// WHY THIS RULE EXISTS (measured 2026-11-13, 13.11. PULS AD -> AE)
//
// HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8 publishes an on-chain IDL
// that declares `points` as `vec<CurvePointInput>`, which means "a u32 Borsh
// length prefix, then the elements". The deployed program writes NO prefix:
// the element count is the `numPoints` u8 the instruction already declares
// in its own header, and the points follow the header directly. Measured on
// 144 chain-accepted payloads (research/hadro-vec-wire-2026-11-13.json):
//
//   wire = 1-byte discriminator + u8 header + numPoints x 21-byte
//          CurvePointInput + an 8-byte tail
//
// What the strict u32-prefix codec did with that, measured on the same
// payloads:
//
//   * 72 setRiskCurve payloads REFUSED with a garbage number — the u32 the
//     codec read as the vector length was the first four bytes of the first
//     curve point;
//   * 72 setCurve payloads "decoded" with points: [] and 46 trailing bytes —
//     an EMPTY curve, described, not decoded. 0 byte-exact.
//
// THE RULE: when a listed program+instruction declares an integer count
// argument BEFORE the vector argument, the vector carries no length prefix on
// the wire; its element count is the count argument's decoded value. The
// encoder half writes the elements without a prefix, and a count that does
// not fit the remaining bytes is refused BY NAME ("no length prefix on the
// wire"), never by a garbage number.
//
// GATES — every one is load-bearing, and each has a guard in
// test/hadro-count-from-header.test.mjs:
//
//   G1  the program address must be the measured program
//       (G4: the same interface under another address keeps the strict codec)
//   G2  the instruction name must be one of the measured names
//       (G4: a shape the table does not name keeps the strict codec)
//   G3  the instruction must DECLARE an integer count argument before the
//       vector argument (G3: removing `numPoints` keeps the strict codec)
//
// A rule that fired on evidence the table was not measured on would decode
// bytes by an argument that happens to be named "numPoints"; the gates are
// what make this a measurement instead of a name match.
//
// Measured on the committed 144 payloads: setCurve (discriminator 0x04) is
// always numPoints=2; setRiskCurve (0x08) carries numPoints in 2..19. The
// tail after the points is 8 bytes for all 144 (an undeclared field the IDL
// does not name — reported as trailing, never invented).

/**
 * The measured count-from-header table, keyed by program address.
 *
 * Every entry is a program+instruction pair whose wire layout was measured
 * against chain-accepted payloads with a committed artifact; nothing here is
 * inferred from an IDL claim or from a shape match. `elementBytes` is the
 * measured size of ONE vector element — a property of the element TYPE the
 * measurement walked, never a global constant: CurvePointInput is 21 bytes
 * (research/hadro-vec-wire-2026-11-13.json: 144/144 payloads fit n x 21),
 * SpreadTriggerInput is 66 (research/live-layout-scan-hadro-witness-
 * 2026-11-14.json: 2/2 chain-accepted live payloads numTriggers=5 x 66 =
 * 330 body bytes, trailingBytes 0).
 */
export const COUNT_FROM_HEADER = {
  HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8: {
    instructions: {
      setCurve: { countArg: 'numPoints', vectorArg: 'points', elementBytes: 21, source: 'research/hadro-vec-wire-2026-11-13.json' },
      setRiskCurve: { countArg: 'numPoints', vectorArg: 'points', elementBytes: 21, source: 'research/hadro-vec-wire-2026-11-13.json' },
      updateSpreadConfig: { countArg: 'numTriggers', vectorArg: 'triggers', elementBytes: 66, source: 'research/live-layout-scan-hadro-witness-2026-11-14.json' },
    },
  },
};

/**
 * Resolve the count-from-header rule for an IDL+instruction, or null.
 *
 * The returned rule is a promise about EVIDENCE, not a hint: it carries the
 * count argument's name, the vector argument's name, and the measured point
 * size. The caller must re-check that the count argument was actually
 * declared (and decoded) before the vector, or the rule has no evidence to
 * speak and must stay silent.
 *
 * @param {object} idl  the IDL being decoded (must carry `address`)
 * @param {string} name  the instruction name being decoded/encoded
 * @returns {{countArg: string, vectorArg: string, elementBytes: number, source: string}|null}
 */
export function countFromHeader(idl, name) {
  const entry = COUNT_FROM_HEADER[idl?.address]?.instructions?.[name];
  if (!entry) return null;
  return { ...entry };
}
