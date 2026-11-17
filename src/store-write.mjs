// Atomic no-replace writer for store objects and receipts.
//
// Extracted from src/pull.mjs so that `sememe adopt` (a published copy with no
// RPC involved) can share the exact same write contract as `sememe pull`:
//   - temp file created O_EXCL with 0600
//   - fsync before install
//   - hard-link install: another writer (or a symlink planted at the target)
//     cannot be overwritten; a losing writer verifies the installed bytes
//   - any existing destination with DIFFERENT bytes is an error, never replaced
// A store entry is content-addressed: overwriting one digest with other bytes
// would break every receipt that points at it.

import { link, lstat, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
// A write INTO the store used to answer with the kernel's errno verbatim
// (measured 2026-11-17 on this host: "EACCES: permission denied, open
// '/tmp/nowrite/objects/…json.tmp-…'" with exit 1). The directory is part
// of a path the CALLER chose, so it gets the same named refusal as every
// other caller-named path. A failure that is NOT a filesystem error — a
// digest collision, a non-regular store entry — keeps its own voice: that
// is the work failing, not the path.
import { classifyStoreErrno, storeRefusal } from './store-input.mjs';

/** Which part of the store a path lives in: the subject a refusal names
 *  (the root itself answers as "store"). */
function storePartOf(filePath) {
  const parent = path.basename(path.dirname(filePath));
  return parent === 'objects' || parent === 'receipts' ? parent : null;
}

export async function writeOnce(destination, content) {
  try {
    await writeOnceInner(destination, content);
  } catch (error) {
    const kind = classifyStoreErrno(error);
    const part = storePartOf(destination);
    if (!kind || !part) throw error;
    throw storeRefusal({
      code: `store-${part}-${kind === 'missing' ? 'unreadable' : kind}`,
      subject: `${part} directory`,
      storePath: path.dirname(destination),
      kind: kind === 'missing' ? 'unreadable' : kind,
    });
  }
}

async function writeOnceInner(destination, content) {
  try {
    const entry = await lstat(destination);
    if (!entry.isFile() || entry.isSymbolicLink()) throw Error(`non-regular store entry: ${destination}`);
    const current = await readFile(destination);
    if (!current.equals(content)) throw Error(`digest collision or corrupted local object: ${destination}`);
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = `${destination}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close(); handle = null;
    // Atomic no-replace installation: hard-link fails if another writer won.
    // Rename would overwrite a concurrently created or symlinked digest path.
    try { await link(temporary, destination); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const entry = await lstat(destination);
      if (!entry.isFile() || entry.isSymbolicLink()) throw Error(`non-regular store entry: ${destination}`);
      const current = await readFile(destination);
      if (!current.equals(content)) throw Error(`digest collision or corrupted local object: ${destination}`);
    }
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}
