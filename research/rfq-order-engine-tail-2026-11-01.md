// The 40-byte `fill` wire of the Jupiter order_engine (2En5Y11SEAGLNmEezTuRUCwTyzyNReHaMbSnS5gjGsL1):
// what the 8 undeclared trailing bytes are NOT — derived, not remembered.
//
// The on-chain IDL, the vendored copies and the first-party repo/SDK describe
// `fill` as discriminator + 24 argument bytes (input_amount u64, output_amount
// u64, expire_at i64). The committed 140-block fixture
// (test/fixtures/harvest-order-engine-2026-11-01.json) contains 59 payloads of
// that described prefix plus exactly 8 more bytes, which the deployed program
// accepted on chain. This table turns the rejection list from the first
// measurement into a reproducible derivation: every hypothesis gets an exact
// match criterion, every count is computed over all 59 payloads, and the
// verdict is the count — nothing here is asserted from memory.
//
// Re-run with `node tools/tail-hypotheses.mjs`; the JSON in research/ must
// match byte-for-byte. test/rfq-stack.test.mjs re-derives the load-bearing
// numbers from the fixture, so a fixture change turns the suite RED instead of
// letting this table go stale.
//
// For every confirmed/refuted hypothesis: an exact reproduction, not an
// interpretation. The structural facts (which bytes vary, their ranges) are
// recorded as bands in the JSON; the meaning of the varying 4 bytes remains
// UNIDENTIFIED, and this table is the proof of what it cannot be.

| Hypothesis | Verdict | Count | How the count is derived (all over the 59 40-byte payloads) |
| --- | --- | --- | --- |
| `crc32(32 described bytes)` as the varying 4 bytes, LE or BE | refuted | 0/59 | zlib.crc32(prefix) compared to tail LE and BE, per payload. |
| First 4 bytes of `sha256(32 described bytes)` | refuted | 0/59 | sha256(prefix) truncated to u32 BE, per payload. |
| Tail = declared `input_amount` mod 2^32, LE / BE | refuted | 0/59 | tail u32 vs prefix u64 truncated, both byte orders. |
| Tail = declared `output_amount` mod 2^32, LE / BE | refuted | 0/59 | same. |
| Tail = declared `expire_at` mod 2^32, LE / BE | refuted | 0/59 | same (two's complement truncation). |
| Tail = slot, LE / BE | refuted | 0/59 | tail u32 vs the transaction's slot from the fixture. |
| Tail = slot + K (constant offset) | refuted | 0/59 | 59 distinct `tail − slot` deltas → no single K. |
| Tail = A·slot + B (mod 2^32), affine | refuted | 0/59 | A,B DERIVED from payload 0 and the first payload with an odd (invertible) delta, then tested against all 59; derived A=2658922943, B=425550080, matches 0. The affine class contains the constant (A=0), any rescaling of seconds→ms→µs, and every prior "X + K" guess — one refutation instead of dozens. |
| Tail = A·expire_at + B (mod 2^32), affine | refuted | 0/59 | same derivation. |
| Tail = A·input_amount + B (mod 2^32), affine | refuted | 0/59 | same derivation. |
| Tail = A·output_amount + B (mod 2^32), affine | refuted | 0/59 | same derivation. |
| Tail (LE) = unix-seconds timestamp near harvest time | refuted | 0/59 | all 59 values ≥ 2.895e9 = year 2061, far outside any real-time window (harvest at 1.795e9 s). BE likewise: BE range spans the whole u32. |
| Tail = first/last 4 bytes of the tx signature | refuted | 0/59 | base58-decoded signature bytes compared to tail (structure report). |

| Structure fact | Value (derived) |
| --- | --- |
| Constant bytes 4..7 of the tail | 69 20 94 06 (LE 0x06942069), 59/59 |
| Varying bytes 0..3 | 51/53/17/2 distinct values per byte position |
| Varying u32 (LE) top byte | only 0xAC (172) and 0xAD (173) across all 59 payloads → the 16 high bits of every value sit in [0xACAB, 0xADCC] |
| Varying u32 (LE) | 59 distinct values in [2,894,799,443 , 2,917,954,340], zero never occurs |
| Monotonic with slot / correlated with slot, amounts, expire_at | no (|r| ≤ 0.17) |
| Same transaction carrying several 40-byte fills | 0 in the fixture |

The varying 4 bytes are NOT identified. The bands above are the reproducible
shape of the unknown; they also refute "random u32" (0.000012% of the space)
and every single-word field carried in the same instruction. Candidate
explanations that survive the numbers and are NOT excluded by any committed
measurement: a 4-byte value derived from cross-instruction or cross-transaction
state (the fixture does not pin the surrounding transaction bytes), or a
field of a NEWER interface revision whose description was never published.
