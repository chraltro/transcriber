// Finished transcripts, kept in this browser (IndexedDB) so they can be reopened later.
// Everything degrades to "no library" where storage isn't available (some private modes).
// The same database keeps what the podcast side has read of each followed show's feed
// (`feeds`), so lists open at once and work offline.
const DB = 'transcriber';
const STORE = 'transcripts';
const FEEDS = 'feeds';
const KEEP = 40;
let opening = null;

function open() {
  opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(FEEDS)) db.createObjectStore(FEEDS, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        // Another tab with a newer copy of the app may need to upgrade it.
        req.result.onversionchange = () => { req.result.close(); opening = null; };
        resolve(req.result);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

async function run(mode, fn, store = STORE) {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
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

// What was last read of a feed: { id, title, episodes, fetchedAt, ... } ('inbox' is the list
// across all shows).
export const getFeed = (id) => run('readonly', (s) => s.get(id), FEEDS);
export const putFeed = (feed) => run('readwrite', (s) => s.put(feed), FEEDS);
export const dropFeed = (id) => run('readwrite', (s) => s.delete(id), FEEDS);
