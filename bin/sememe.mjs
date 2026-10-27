#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { pull } from '../src/pull.mjs';
import { decodePayload } from '../src/decode.mjs';

const usage = `usage:
  sememe pull <program-id> [--store <directory>] [--rpc <https-url>]
  sememe decode <program-id> <payload> [--store <directory>]
      payload: base58 or hex instruction data (discriminator + args)`;

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
    console.log(JSON.stringify(await decodePayload(store, program, payload), null, 2));
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ error: String(error?.message ?? error) }));
  process.exitCode = 1;
}
