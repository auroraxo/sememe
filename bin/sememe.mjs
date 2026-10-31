#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { pull } from '../src/pull.mjs';
import { decodePayload, decodeStoredAccount, decodeUnionPayload, adopt, parsePayload } from '../src/decode.mjs';
import {
  decodeNativeInstruction, nativeProvenance, nativePrograms,
} from '../src/native.mjs';
import { toJsonSafe } from '../src/codec.mjs';

const usage = `usage:
  sememe pull <program-id> [--store <directory>] [--rpc <https-url>]
  sememe adopt <program-id> <file> [--store <directory>] [--source <label>]
      store a first-party PUBLISHED interface copy next to the on-chain pull, so
      union decode has a second verified source. The receipt says "published":
      it is provenance of bytes, not proof the bytes describe the deployed program.
  sememe decode <program-id> <payload> [--store <directory>] [--trailing report|error]
      payload: base58 or hex instruction data (discriminator + args)
      --trailing report (default): decode the IDL-described prefix and report
          the bytes the IDL does not explain under "trailing"; --trailing error
          refuses the payload instead.
  sememe decode --union <program-id> <payload> [--store <directory>]
      decode against BOTH stored sources (on-chain + adopted). The result names
      the source that answered, the other source's verdict, and any layout
      drift between them. Byte evidence arbitrates; a name conflict is refused.
  sememe account <program-id> <account-data> [--store <directory>] [--name <account-type>]
      account-data: base64 account bytes (as getMultipleAccounts returns them)
          or hex. Without --name the account's 8-byte discriminator picks the
          account type from the stored IDL.
  sememe decode-native <program-id> <payload> [--trailing report|error]
      payload: base58 or hex instruction data. For the NATIVE programs (System,
      ComputeBudget) there is no IDL to pull: their interface is pinned from
      the upstream runtime, and this decodes against that pin. The result names
      the instruction, its arguments, and whether the bytes re-encode exactly.
  sememe native-provenance [program-id]
      print the pinned source, encoding rule and measured traffic for a native
      program (or for all of them).`;

const [rawCommand, rawProgram, ...rawArgs] = process.argv.slice(2);
const command = rawCommand;
// `decode --union <program> <payload>` puts the flag where the program id
// would be; strip it up front so either flag position works and the flag can
// never be mistaken for a program id or a payload.
let program = rawProgram;
const args = rawArgs;
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
  if (command === 'pull') {
    if (!program) throw Error('pull needs a program id');
    const store = option('--store', path.join(os.homedir(), '.sememe'));
    const rpc = option('--rpc', 'https://api.mainnet-beta.solana.com');
    console.log(JSON.stringify(await pull(program, store, rpc), null, 2));
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
    const union = unionRequested;
    const decoded = union
      ? await decodeUnionPayload(store, program, payload,
        trailing === undefined ? {} : { trailing })
      : await decodePayload(store, program, payload,
        trailing === undefined ? {} : { trailing });
    console.log(JSON.stringify(decoded, null, 2));
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
