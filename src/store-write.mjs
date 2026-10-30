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

export async function writeOnce(destination, content) {
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
