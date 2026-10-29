#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { pull } from '../src/pull.mjs';
import { decodePayload } from '../src/decode.mjs';

const usage = `usage:
  sememe pull <program-id> [--store <directory>] [--rpc <https-url>]
  sememe decode <program-id> <payload> [--store <directory>] [--trailing report|error]
      payload: base58 or hex instruction data (discriminator + args)
      --trailing report (default): decode the IDL-described prefix and report
          the bytes the IDL does not explain under "trailing"; --trailing error
          refuses the payload instead.`;

const [command, program, ...args] = process.argv.slice(2);
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
  } else if (command === 'decode') {
    if (!program) throw Error('decode needs a program id');
    const payload = args.shift();
    if (!payload) throw Error('decode needs an instruction payload');
    const store = option('--store', path.join(os.homedir(), '.sememe'));
    const trailing = option('--trailing', undefined);
    if (trailing !== undefined && trailing !== 'report' && trailing !== 'error') {
      throw Error('--trailing must be "report" or "error"');
    }
    const decoded = await decodePayload(store, program, payload,
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
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ error: String(error?.message ?? error) }));
  process.exitCode = 1;
}
