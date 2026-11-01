/**
 * native-audit.mjs — THE DERIVATION AUDIT, callable by a consumer.
 *
 * tools/native-interface.mjs --check answers "is the committed interface artifact exactly
 * what the vendored upstream Rust derives to today?" — but as a subprocess in sememe's own
 * checkout. A consumer that installed the package has no checkout and no tools/ directory
 * (deliberately: the qualification harness does not ship), so this module carries the same
 * verdict as an import: re-derive both pinned native interfaces from vendor/ and compare
 * against the shipped interface/ artifacts byte-for-byte.
 *
 * This is the same audit sememe's own suite runs (test/native-interface.test.mjs), moved to
 * a package surface. It exists so a consumer can falsify the table it was handed instead of
 * trusting it: the verdict is derived in the consumer's process from the shipped upstream
 * bytes, not read from a log the producer wrote about itself.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveAll } from './native-interface.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INTERFACE_DIR = path.resolve(HERE, '..', 'interface');

/**
 * Re-derive every pinned native interface from the vendored upstream sources and compare
 * with the shipped artifacts.
 *
 * Returns `{ ok, checked, stale, missing, error }` where `checked` is the number of
 * artifacts compared and `stale` names each artifact whose bytes differ from a fresh
 * derivation. `ok === false` with a non-empty `stale` is the interesting failure: the
 * derivation rules or the vendored bytes moved without the committed artifact following.
 */
export function auditNativeInterface() {
  const stale = [];
  const missing = [];
  let checked = 0;
  let docs;
  try {
    docs = deriveAll();
  } catch (error) {
    return { ok: false, checked, stale, missing, error: `derivation failed: ${error.message}` };
  }
  for (const doc of docs) {
    const file = path.join(INTERFACE_DIR, `native-${doc.program}.json`);
    let current;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      missing.push(path.basename(file));
      continue;
    }
    checked += 1;
    if (current !== `${JSON.stringify(doc, null, 2)}\n`) stale.push(path.basename(file));
  }
  return { ok: stale.length === 0 && missing.length === 0, checked, stale, missing, error: null };
}
