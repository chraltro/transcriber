// Finished transcripts, kept in this browser (IndexedDB) so they can be reopened later.
// Everything degrades to "no library" where storage isn't available (some private modes).
const DB = 'transcriber';
const STORE = 'transcripts';
const KEEP = 40;
let opening = null;

function open() {
  opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

async function run(mode, fn) {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : true);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function listEntries() {
  const all = (await run('readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export const getEntry = (id) => run('readonly', (s) => s.get(id));

export async function saveEntry(entry) {
  const ok = await run('readwrite', (s) => s.put(entry));
  const all = await listEntries();
  for (const old of all.slice(KEEP)) await deleteEntry(old.id);
  return ok;
}

export const deleteEntry = (id) => run('readwrite', (s) => s.delete(id));
