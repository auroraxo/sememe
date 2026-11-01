/**
 * native-corpus.mjs — sememe's REAL MAINNET NATIVE-PROGRAM CORPUS, shipped with the package.
 *
 * The two harvests here are the measured traffic the native decoder was qualified against
 * (2026-10-31): every System and ComputeBudget payload pulled from live mainnet blocks,
 * with the bytes the chain actually carried. A decoder can be checked against invented
 * bytes; these are not invented — each carries its own provenance (slot, block, index)
 * inside the harvest document.
 *
 * Why this ships instead of staying a test fixture: sememe's first in-tree consumer
 * (solana-tx-remix) falsifies its own native path against the SAME corpus — "the table I
 * consume names the chain's traffic" is a claim about the consumer, and the bytes it is
 * judged on must be the producer's, not a stale copy. A copy in the consumer's tree is
 * exactly the drift this package exists to end. The corpus is addressed by its sha256, so
 * the consumer can pin and re-hash what it was given.
 *
 * `default` returns the whole document; `payloads(program)` flattens the wire bytes to
 * Buffers. Neither decodes anything: reading is this module's whole job.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

export const CORPUS = {
  system: { file: 'harvest-system-2026-10-31.json', sha256: 'sha256:75c7052ebc8e1f18a0e2cb3fb1fb70b9963141f86b5994b3f1e64b4d9c64fd7d' },
  computeBudget: { file: 'harvest-compute-budget-2026-10-31.json', sha256: 'sha256:25354bf24977ee52371cf307db2edab9fa7108662d68018db2aba63ba8172295' },
};

/** One harvest document, byte-hashed on every read. */
export function corpus(which) {
  const entry = CORPUS[which];
  if (!entry) throw Error(`unknown corpus ${String(which)}; expected one of ${Object.keys(CORPUS).join(', ')}`);
  const raw = readFileSync(path.join(HERE, 'corpus', entry.file));
  const actual = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  if (actual !== entry.sha256) {
    throw Error(`corpus ${which} re-hashes to ${actual}, expected ${entry.sha256} — the shipped bytes are not the qualified ones`);
  }
  return JSON.parse(raw);
}

/** Every wire payload in one harvest, as Buffers (payload.dataHex). */
export function payloads(which) {
  const document = corpus(which);
  const out = [];
  for (const transaction of document.transactions ?? []) {
    for (const payload of transaction.payloads ?? []) {
      if (typeof payload.dataHex === 'string') out.push(Buffer.from(payload.dataHex, 'hex'));
    }
  }
  return out;
}
