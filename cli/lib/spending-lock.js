// Short synchronous transactions only: never hold this across a provider call.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isAlive } from './renderlock.js';

const held = new Set();
const pause = new Int32Array(new SharedArrayBuffer(4));

export function spendingTransaction(dir, operation) {
  const folder = resolve(dir, 'spending');
  if (held.has(folder)) return operation();
  mkdirSync(folder, { recursive: true });
  const name = `owner-${process.pid}-${randomUUID()}`;
  const pending = join(folder, `.${name}`), lock = join(folder, '.ledger.lock');
  mkdirSync(pending);
  // Publishing a filled directory avoids a lock with no owner during acquisition.
  writeFileSync(join(pending, name), '', { flag: 'wx', mode: 0o600 });
  let acquired = false;
  const remove = path => {
    try { unlinkSync(join(path, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { rmdirSync(path); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  };
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      try { renameSync(pending, lock); acquired = true; break; }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        let owners;
        try { owners = readdirSync(lock); } catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
        const owner = owners.length === 1 && /^owner-(\d+)-[a-f0-9-]+$/.exec(owners[0]);
        if (owner && !isAlive(Number(owner[1]))) {
          // Delete only that dead owner's unique name. A concurrent reaper cannot
          // delete a replacement owner; rmdir never removes a nonempty lock.
          try { unlinkSync(join(lock, owner[0])); }
          catch (removeError) { if (removeError.code === 'ENOENT') continue; throw removeError; }
          try { rmdirSync(lock); } catch (removeError) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(removeError.code)) throw removeError; }
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`Spending ledger is busy${owner ? ` (pid ${owner[1]})` : ''}; retry after its writer finishes`);
        Atomics.wait(pause, 0, 0, 10);
      }
    }
    held.add(folder);
    return operation();
  } finally {
    held.delete(folder);
    remove(acquired ? lock : pending);
  }
}
