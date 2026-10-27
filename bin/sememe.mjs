#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { pull } from '../src/pull.mjs';

const [command, program, ...args] = process.argv.slice(2);
if (command !== 'pull' || !program) {
  console.error('usage: sememe pull <program-id> [--store <directory>] [--rpc <https-url>]');
  process.exitCode = 2;
} else {
  let store = path.join(os.homedir(), '.sememe');
  let rpc = 'https://api.mainnet-beta.solana.com';
  try {
    for (let index = 0; index < args.length; index += 2) {
      if (index + 1 >= args.length) throw Error('missing option value');
      if (args[index] === '--store') store = args[index + 1];
      else if (args[index] === '--rpc') rpc = args[index + 1];
      else throw Error(`unknown option: ${args[index]}`);
    }
    console.log(JSON.stringify(await pull(program, store, rpc), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: String(error?.message ?? error) }));
    process.exitCode = 1;
  }
}
