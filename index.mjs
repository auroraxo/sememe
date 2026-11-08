// sememe's package entry: the offline decode surface, and nothing else.
//
// The split is deliberate and enforced (test/package.test.mjs,
// test/deps.test.mjs):
//
//   the entry ("sememe")
//     - decodes instructions, accounts and event self-CPIs from a local,
//       fingerprint-verified store; re-checks the receipt on every read;
//     - imports only node: builtins and files inside this package, so a
//       consumer installs ZERO runtime dependencies;
//     - never touches the network, the CLI, or the qualification harness.
//
//   the acquisition subpath ("sememe/pull")
//     - acquisition: finds a program's IDL account on chain and writes the
//       store. Needs @solana/web3.js (declared as an optional peer) and a
//       network. A decoder-only consumer never loads it.
//
// A package that exports its harness is a harness. This file exists so the
// consumer's surface is a list you can read in one screen.

export {
  decodePayload,
  decodeUnionPayload,
  decodeStoredAccount,
  decodeUnionStoredAccount,
  findStoredIdl,
  findStoredIdls,
  adopt,
  parsePayload,
  decodeHex,
  decodeBase58,
  unionDecode,
  unionAccountDecode,
  UnionRefusal,
  verifiedShortForm,
  VERIFIED_SHORT_FORMS,
} from './src/decode.mjs';

export { encodeBase58 } from './src/base58.mjs';
export { canonicalJson } from './src/canonical.mjs';
// The native programs (System, ComputeBudget) are NOT re-exported here on
// purpose: src/native.mjs derives its wire table from the pinned upstream
// sources AT IMPORT TIME and refuses to load when the committed artifact
// disagrees. That loud failure is right for the native decoder, but it must
// not take the whole entry down for a consumer who only decodes an Anchor
// instruction. Use `sememe/native` for those two programs. The same applies
// to the two token programs (SPL Token, Token-2022) — `sememe/token` derives
// their wire tables from the pinned upstream Rust crates the same way.
