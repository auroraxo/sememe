#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
// `pull` is imported LAZILY (inside the branch): it is the only path that
// needs @solana/web3.js. A consumer who installed the package for DECODING
// only — the common case — must be able to run `sememe decode` without any
// package installed at all, so the acquisition dependency is never loaded
// unless a pull is actually requested.
import { decodePayload, decodeStoredAccount, decodeUnionPayload, adopt, parsePayload } from '../src/decode.mjs';
import {
  decodeNativeInstruction, nativeProvenance, nativePrograms, isNativeProgram,
} from '../src/native.mjs';
import {
  decodeTokenInstruction, tokenProvenance, tokenPrograms, isTokenProgram,
} from '../src/token.mjs';
import {
  decodeRaydiumInstruction, raydiumProvenance, raydiumPrograms, isRaydiumProgram,
} from '../src/raydium.mjs';
import { toJsonSafe } from '../src/codec.mjs';
import { VERIFIED_SHORT_FORMS, SHORT_FORM_SOURCE } from '../src/short-forms.mjs';

const usage = `usage:
  sememe absent-help
      print the chain-verified short wire forms that --absent verified licenses.
  sememe pull <program-id> [--store <directory>] [--rpc <https-url>]
  sememe gap <program-id> [--rpc <https-url>]
      answer the question "why is there no interface here?" BEFORE you pull.
      Probes both on-chain IDL addresses and returns one of:
        pullable              an interface exists on chain that this program's
                              store simply does not have yet -> run sememe pull
        no-interface-published  neither address answers -> pulling it can never
                              help: adopt a published copy or derive upstream
        present-undecodable   an account exists but its schema is unusable
        vendored              answered by sememe's pinned wire table, no IDL
        unknown               the RPC failed — deliberately NOT an absence
      Never reports an RPC failure as an absence, and never tells you to pull
      a program that publishes nothing (the fix would never arrive).
  sememe adopt <program-id> <file> [--store <directory>] [--source <label>]
      store a first-party PUBLISHED interface copy next to the on-chain pull, so
      union decode has a second verified source. The receipt says "published":
      it is provenance of bytes, not proof the bytes describe the deployed program.
  sememe lock [--store <directory>] [--out <file>]
      snapshot the WHOLE store into a sememe.lock document: for every program,
      the exact fingerprint its newest verified receipt answered with, plus
      source/slot/receipt provenance. Every receipt is re-checked through the
      store reader first — a store the reader refuses produces NO lock, never
      a lock over damage. Commit the file; CI then runs "sememe verify".
  sememe verify [--store <directory>] [--lock <file>] [--mode error|warn]
      re-check the store against the lock and refuse drift BY NAME:
        drifted     the store answers a pinned program with a DIFFERENT
                    fingerprint (a newer pull replaced it) — reported with
                    both fingerprints
        missing     the store has no receipt for a pinned program
        unverified  a pinned object fails the store reader's re-hash check
      Extra store programs are reported, never a violation: the lock pins
      minimums, not store equality. --mode error (default) exits 1 when any
      violation exists (the CI gate); --mode warn reports and exits 0.
  sememe decode <program-id> <payload> [--store <directory>] [--trailing report|error] [--absent error|report|verified]
      payload: base58 or hex instruction data (discriminator + args)
      --trailing report (default): decode the IDL-described prefix and report
          the bytes the IDL does not explain under "trailing"; --trailing error
          refuses the payload instead.
      --absent error (default): a payload that ENDS where a declared field
          would start is refused as truncated. --absent report: decode it and
          name the absent fields. --absent verified: decode it only when a
          chain witness covers that exact wire form (see --absent-help).
  sememe decode --union <program-id> <payload> [--store <directory>]
      decode against BOTH stored sources (on-chain + adopted). The result names
      the source that answered, the other source's verdict, and any layout
      drift between them. Byte evidence arbitrates; a name conflict is refused.
  sememe account <program-id> <account-data> [--store <directory>] [--name <account-type>]
      account-data: base64 account bytes (as getMultipleAccounts returns them)
          or hex. Without --name the account's 8-byte discriminator picks the
          account type from the stored IDL.
  sememe conform <transaction.json> [--store <directory>] [--only <program-id>]
      transaction.json: an RPC getTransaction/getBlock response entry
          (encoding "json") with its meta — as saved by any RPC client.
      Checks EVERY instruction of the transaction against the interface the
      verified store declares for its program: account count, signer flags,
      pinned addresses, and extra accounts. A disagreement is named; an
      unreadable transaction shape is REFUSED, never reported as conforming.
  sememe decode-native <program-id> <payload> [--trailing report|error]
      payload: base58 or hex instruction data. For the NATIVE programs (System,
      ComputeBudget) there is no IDL to pull: their interface is pinned from
      the upstream runtime, and this decodes against that pin. The result names
      the instruction, its arguments, and whether the bytes re-encode exactly.
  sememe native-provenance [program-id]
      print the pinned source, encoding rule and measured traffic for a native
      program (or for all of them).
  sememe decode-token <program-id> <payload> [--trailing report|error]
      payload: base58 or hex instruction data. For SPL TOKEN and TOKEN-2022
      there is no IDL account to pull at either address: their interface is
      pinned from the upstream Rust crates (pack/unpack wire rule), and this
      decodes against that pin. Extension sub-instructions report as trailing.
      Token-2022 payloads whose first byte is no token tag fall through to the
      token-METADATA table (spl-token-metadata-interface, 8-byte
      discriminators) — the same fallback Token-2022's own processor takes.
  sememe token-provenance [program-id]
      print the pinned crate, encoding rule and variant count for a token
      program (or for both).
  sememe decode-raydium <program-id> <payload> [--trailing report|error]
      payload: base58 or hex instruction data. For RAYDIUM AMM V4 there is no
      IDL account to pull at either address: its interface is pinned from the
      upstream program source (sparse u8 tag, pack/unpack wire rule), and this
      decodes against that pin. Variants upstream itself refuses stay refused.
  sememe raydium-provenance [program-id]
      print the pinned upstream commit, encoding rule and variant counts for a
      Raydium program (or for all of them).`; 

const [rawCommand, rawProgram, ...rawArgs] = process.argv.slice(2);
const command = rawCommand;
// `decode --union <program> <payload>` puts the flag where the program id
// would be; strip it up front so either flag position works and the flag can
// never be mistaken for a program id or a payload.
let program = rawProgram;
const args = rawArgs;
// `lock` and `verify` take NO positional program: their second argv slot is
// always a flag (`--store`, `--out`, `--lock`, `--mode`). Push it back into
// the option stream so `option()` sees it instead of the program slot.
if (program !== undefined && (rawCommand === 'lock' || rawCommand === 'verify') && program.startsWith('-')) {
  args.unshift(program);
  program = undefined;
}
let unionRequested = false;
if (program === '--union') {
  unionRequested = true;
  program = args.shift();
}
for (;;) {
  const index = args.indexOf('--union');
  if (index < 0) break;
  unionRequested = true;
  args.splice(index, 1);
}
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};

try {
  if (command === 'absent-help') {
    // The evidence behind --absent verified, printed so a user can see WHICH
    // wire forms are licensed before relying on the flag.
    console.log(JSON.stringify({
      source: SHORT_FORM_SOURCE,
      forms: VERIFIED_SHORT_FORMS,
    }, null, 2));
  } else if (command === 'pull') {
    if (!program) throw Error('pull needs a program id');
    const store = option('--store', path.join(os.homedir(), '.sememe'));
    const rpc = option('--rpc', 'https://api.mainnet-beta.solana.com');
    let pull;
    try {
      ({ pull } = await import('../src/pull.mjs'));
    } catch (error) {
      // The library already refuses with a complete sentence naming the fix
      // (src/peer.mjs); wrapping it again produced a doubled message that
      // said "install it next to sememe" twice. Anything else still gets the
      // contextual wrap with the cause appended.
      if (error?.code === 'peer_dependency_missing') throw error;
      throw Error(`pull needs @solana/web3.js: install it next to sememe (npm i @solana/web3.js@1.98.4) — ${String(error?.message ?? error).slice(0, 120)}`);
    }
    console.log(JSON.stringify(await pull(program, store, rpc), null, 2));
  } else if (command === 'gap') {
    if (!program) throw Error('gap needs a program id');
    const rpc = option('--rpc', 'https://api.mainnet-beta.solana.com');
    let probe, where, nextStep;
    try {
      // Lazily imported like `pull`: the only path that needs web3.js.
      ({ probeGap: probe, nextStep } = await import('../src/gap.mjs'));
      ({ addresses: where } = await import('../src/acquire.mjs'));
    } catch (error) {
      if (error?.code === 'peer_dependency_missing') throw error;
      throw Error(`gap needs @solana/web3.js: install it next to sememe (npm i @solana/web3.js@1.98.4) — ${String(error?.message ?? error).slice(0, 120)}`);
    }
    // The same classifier the qualification report uses, so what a user is
    // told and what the research artifact records are one code path.
    const { rows } = await probe([{ program, payloads: 0 }], { url: rpc });
    const row = rows[0];
    console.log(JSON.stringify({ ...row, addresses: await where(program), next: nextStep(row, program) }, null, 2));
    if (row.verdict === 'unknown') process.exitCode = 3;
  } else if (command === 'lock') {
    if (!program) {
      // No program argument: lock the WHOLE store (the common case). A program
      // id here would otherwise be swallowed silently, so an explicit store
      // wide lock must be chosen by omitting the argument entirely.
      const store = option('--store', path.join(os.homedir(), '.sememe'));
      const out = option('--out', 'sememe.lock');
      const { writeLock } = await import('../src/lock.mjs');
      const doc = await writeLock(store, out);
      console.log(JSON.stringify(doc, null, 2));
    } else {
      throw Error(`lock takes no program id — it snapshots the whole store; got "${program}"`);
    }
  } else if (command === 'verify') {
    const store = option('--store', path.join(os.homedir(), '.sememe'));
    const lockFile = option('--lock', 'sememe.lock');
    const mode = option('--mode', 'error');
    if (mode !== 'error' && mode !== 'warn') throw Error('--mode must be "error" or "warn"');
    if (program) throw Error(`verify takes no program id — it checks the whole lock; got "${program}"`);
    const { checkLock } = await import('../src/lock.mjs');
    const report = await checkLock(store, lockFile, { mode });
    console.log(JSON.stringify(report, null, 2));
    if (report.violations > 0) {
      console.error(JSON.stringify({
        note: `store does not match ${lockFile}: ${report.drifted.length} drifted, ${report.missing.length} missing, ${report.unverified.length} unverified`,
        drifted: report.drifted.map((d) => d.program),
        missing: report.missing,
        unverified: report.unverified.map((u) => u.program),
      }));
      // The note goes to stderr as a WARNING. The exit stays 0: in error mode
      // checkLock already threw above (that is the gate), so reaching here
      // with violations can only be warn mode — a warning that fails the
      // build is not a warning.
    }
  } else if (command === 'adopt') {
    if (!program) throw Error('adopt needs a program id');
    const file = args.shift();
    if (!file) throw Error('adopt needs the interface file to store');
    const store = option('--store', path.join(os.homedir(), '.sememe'));
    const source = option('--source', 'published');
    const origin = option('--origin', undefined);
    console.log(JSON.stringify(await adopt(program, file, store, {
      source,
      ...(origin === undefined ? {} : { origin }),
    }), null, 2));
  } else if (command === 'decode') {
    if (!program) throw Error('decode needs a program id');
    const payload = args.shift();
    if (!payload) throw Error('decode needs an instruction payload');
    const store = option('--store', path.join(os.homedir(), '.sememe'));
    const trailing = option('--trailing', undefined);
    if (trailing !== undefined && trailing !== 'report' && trailing !== 'error') {
      throw Error('--trailing must be "report" or "error"');
    }
    const absent = option('--absent', undefined);
    if (absent !== undefined && !['error', 'report', 'verified'].includes(absent)) {
      throw Error('--absent must be "error", "report" or "verified"');
    }
    const union = unionRequested;
    const extra = { ...(trailing === undefined ? {} : { trailing }), ...(absent === undefined ? {} : { absent }) };
    // A program that publishes NO interface — the two token programs, the two
    // native programs, Raydium AMM v4 — has no stored receipt, so the store
    // path cannot answer for it. That is not a missing-pull problem and the
    // error must not say it is: name the vendored path that CAN answer, or a
    // first-time user reads "run sememe pull" as the fix and pulls forever.
    const vendored = (programId) => (isTokenProgram(programId) ? 'decode-token'
      : isNativeProgram(programId) ? 'decode-native'
        : isRaydiumProgram(programId) ? 'decode-raydium' : null);
    let decoded;
    try {
      decoded = union
        ? await decodeUnionPayload(store, program, payload, extra)
        : await decodePayload(store, program, payload, extra);
    } catch (error) {
      const message = String(error?.message ?? error);
      const command = vendored(program);
      if (command && (message.startsWith('no stored IDL for program') || message.startsWith('no sememe store at'))) {
        // The vendored answer is the whole answer: no pull will ever create a
        // receipt for this program, so the "run sememe pull" part of the
        // store's message is dropped rather than left to contradict the hint.
        throw Error(`${program} publishes no interface to pull, so there is nothing to store — ` +
          `its wire table is pinned from upstream instead.\n` +
          `  use: sememe ${command} ${program} <payload>`);
      }
      throw error;
    }
    console.log(JSON.stringify(decoded, null, 2));
    // A short-form decode is a measurement-backed claim, so the evidence is
    // surfaced on stderr as well: a scripted caller should not have to know
    // to look inside the JSON to learn the field was absent and why.
    if (decoded.shortForm) {
      console.error(JSON.stringify({
        note: `${decoded.name} decoded as a chain-verified short form: the wire carries no `
          + `${JSON.stringify(decoded.shortForm.absent)}`,
        verified: decoded.shortForm.verified,
        absent: decoded.shortForm.absent,
        witnesses: decoded.shortForm.witnesses,
        source: decoded.shortForm.source,
      }));
    }
    // Unexplained bytes are a completeness finding, not a crash: report them
    // on stderr so scripted callers notice without losing the decode result.
    if (decoded.trailing.count > 0 && trailing !== 'error') {
      console.error(JSON.stringify({
        note: `${decoded.trailing.count} byte(s) after ${decoded.name} are not described by the stored IDL`,
        consumed: decoded.consumed,
        bytes: decoded.bytes,
        trailing: decoded.trailing,
      }));
    }
  } else if (command === 'conform') {
    // The first positional after `conform` is the file (it lands in `program`
    // like every other command's first argument).
    const file = program ?? args.shift();
    if (!file) throw Error('conform needs a transaction JSON file');
    const store = option('--store', path.join(os.homedir(), '.sememe'));
    const only = option('--only', undefined);
    const envelope = JSON.parse(readFileSync(file, 'utf8'));
    // Accept either a bare transaction entry or the full RPC envelope.
    const transaction = envelope?.result ?? envelope;
    const { checkTransaction } = await import('../src/conformance.mjs');
    const report = await checkTransaction(transaction, store, only ? { only: [only] } : {});
    console.log(JSON.stringify(report, null, 2));
    const disagreement = report.summary.byVerdict;
    const violations = Object.entries(disagreement)
      .filter(([kind]) => ['missing-declared-accounts', 'declared-signer-not-signing', 'fixed-address-mismatch', 'undeclared-signing-account'].includes(kind));
    if (violations.length) {
      console.error(JSON.stringify({ note: 'account-list disagreement(s) found', kinds: violations.map(([kind, count]) => `${kind}:${count}`) }));
      process.exitCode = 1;
    }
  } else if (command === 'decode-native') {
    if (!program) throw Error('decode-native needs a program id');
    const payload = args.shift();
    if (!payload) throw Error('decode-native needs an instruction payload');
    const trailing = option('--trailing', 'report');
    if (trailing !== 'report' && trailing !== 'error') {
      throw Error('--trailing must be "report" or "error"');
    }
    const decoded = decodeNativeInstruction(program, parsePayload(payload), { trailing });
    console.log(JSON.stringify({
      program,
      kind: 'native-instruction',
      name: decoded.name,
      selector: decoded.selector,
      selectorWidth: decoded.selectorWidth,
      args: toJsonSafe(decoded.args),
      bytes: decoded.bytes,
      consumed: decoded.consumed,
      trailing: decoded.trailing,
      roundTripByteExact: decoded.roundTripByteExact,
      interface: nativeProvenance(program),
    }, null, 2));
  } else if (command === 'native-provenance') {
    const wanted = program;
    if (wanted) {
      const provenance = nativeProvenance(wanted);
      if (!provenance) throw Error(`${wanted} is not a native program sememe pins`);
      console.log(JSON.stringify(provenance, null, 2));
    } else {
      console.log(JSON.stringify(nativePrograms().map((id) => nativeProvenance(id)), null, 2));
    }
  } else if (command === 'decode-token') {
    if (!program) throw Error('decode-token needs a program id');
    const payload = args.shift();
    if (!payload) throw Error('decode-token needs an instruction payload');
    const trailing = option('--trailing', 'report');
    if (trailing !== 'report' && trailing !== 'error') {
      throw Error('--trailing must be "report" or "error"');
    }
    const decoded = decodeTokenInstruction(program, parsePayload(payload), { trailing });
    if (decoded.refused === 'not-token') {
      throw Error(`${program} is not a token program sememe pins — try decode-native or decode`);
    }
    console.log(JSON.stringify({
      program,
      kind: 'token-instruction',
      name: decoded.name,
      tag: decoded.tag,
      selectorWidth: decoded.selectorWidth,
      args: toJsonSafe(decoded.args),
      authorityType: decoded.authorityType,
      bytes: decoded.bytes,
      consumed: decoded.consumed,
      trailing: decoded.trailing,
      roundTripByteExact: decoded.roundTripByteExact,
      interface: tokenProvenance(program),
    }, null, 2));
  } else if (command === 'token-provenance') {
    const wanted = program;
    if (wanted) {
      const provenance = tokenProvenance(wanted);
      if (!provenance) throw Error(`${wanted} is not a token program sememe pins`);
      console.log(JSON.stringify(provenance, null, 2));
    } else {
      console.log(JSON.stringify(tokenPrograms().map((id) => tokenProvenance(id)), null, 2));
    }
  } else if (command === 'raydium-provenance') {
    const wanted = program;
    if (wanted) {
      const provenance = raydiumProvenance(wanted);
      if (!provenance) throw Error(`${wanted} is not a Raydium program sememe pins`);
      console.log(JSON.stringify(provenance, null, 2));
    } else {
      console.log(JSON.stringify(raydiumPrograms().map((id) => raydiumProvenance(id)), null, 2));
    }
  } else if (command === 'decode-raydium') {
    if (!program) throw Error('decode-raydium needs a program id');
    const payload = args.shift();
    if (!payload) throw Error('decode-raydium needs an instruction payload');
    const trailing = option('--trailing', 'report');
    if (trailing !== 'report' && trailing !== 'error') {
      throw Error('--trailing must be "report" or "error"');
    }
    const decoded = decodeRaydiumInstruction(program, parsePayload(payload), { trailing });
    if (decoded.refused === 'not-raydium') {
      throw Error(`${program} is not a Raydium program sememe pins — try decode-native, decode-token or decode`);
    }
    console.log(JSON.stringify({
      program,
      kind: 'raydium-instruction',
      name: decoded.name,
      tag: decoded.tag,
      selectorWidth: decoded.selectorWidth,
      args: toJsonSafe(decoded.args),
      absent: decoded.absent,
      bytes: decoded.bytes,
      consumed: decoded.consumed,
      trailing: decoded.trailing,
      roundTripByteExact: decoded.roundTripByteExact,
      interface: raydiumProvenance(program),
    }, null, 2));
  } else if (command === 'account') {
    if (!program) throw Error('account needs a program id');
    const data = args.shift();
    if (!data) throw Error('account needs the account data (base64 or hex)');
    const store = option('--store', path.join(os.homedir(), '.sememe'));
    const name = option('--name', undefined);
    const trailing = option('--trailing', undefined);
    if (trailing !== undefined && trailing !== 'report' && trailing !== 'error') {
      throw Error('--trailing must be "report" or "error"');
    }
    const decoded = await decodeStoredAccount(store, program, data,
      name === undefined ? { trailing } : { name, trailing });
    console.log(JSON.stringify(decoded, null, 2));
    if (decoded.trailing.count > 0 && trailing !== 'error') {
      console.error(JSON.stringify({
        note: `${decoded.trailing.count} byte(s) after the described struct are not described by the stored IDL`,
        consumed: decoded.consumed,
        bytes: decoded.bytes,
        trailing: decoded.trailing,
      }));
    }
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ error: String(error?.message ?? error) }));
  process.exitCode = 1;
}
