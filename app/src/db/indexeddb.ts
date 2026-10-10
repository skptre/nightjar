const IDB_NAME = 'nightjar';
const IDB_VERSION = 1;
const IDB_STORE = 'keyval';
const DB_KEY = 'database';
// Chromium limits the size of an individual IndexedDB value even when the
// origin has plenty of free quota. Keep every stored value well below that cap.
const CHUNK_BYTES = 8 * 1024 * 1024;
const manifestKey = (key: string): string => `${key}:chunks`;
const chunkKey = (key: string, index: number): string => `${key}:chunk:${index}`;
export async function clearRecoveryStorage(): Promise<void> {
  const idb = await openIDB();
  try {
    await new Promise<void>((resolve,reject) => {
      const tx = idb.transaction(IDB_STORE,'readwrite');
      const prefixes = ['workspace-daily','workspace-before-update','workspace-before-restore','before-migration'];
      const request = tx.objectStore(IDB_STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const cursorKey = cursor.key;
        if (typeof cursorKey === 'string' && prefixes.some(key => cursorKey === key || cursorKey === manifestKey(key) || cursorKey.startsWith(`${key}:chunk:`))) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Could not remove recovery copies'));
      tx.onerror = () => reject(tx.error);
    });
  } finally { idb.close(); }
}

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE)) {
        request.result.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadDatabase(key = DB_KEY): Promise<Uint8Array | null> {
  const idb = await openIDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const request = store.get(manifestKey(key));
      request.onsuccess = () => {
        const count: unknown = request.result;
        if (count === undefined) {
          const legacy = store.get(key);
          legacy.onsuccess = () => resolve(legacy.result instanceof Uint8Array ? legacy.result : null);
          legacy.onerror = () => reject(legacy.error);
          return;
        }
        if (!Number.isSafeInteger(count) || Number(count) < 0) { reject(new Error('Local database manifest is invalid')); return; }
        const chunks: Uint8Array[] = new Array(Number(count));
        let remaining = chunks.length;
        if (remaining === 0) { resolve(new Uint8Array()); return; }
        for (let index = 0; index < chunks.length; index++) {
          const chunk = store.get(chunkKey(key, index));
          chunk.onsuccess = () => {
            if (!(chunk.result instanceof Uint8Array)) { reject(new Error('Local database chunk is missing')); return; }
            chunks[index] = chunk.result;
            if (--remaining === 0) {
              const data = new Uint8Array(chunks.reduce((sum, part) => sum + part.length, 0));
              let offset = 0;
              for (const part of chunks) { data.set(part, offset); offset += part.length; }
              resolve(data);
            }
          };
          chunk.onerror = () => reject(chunk.error);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    idb.close();
  }
}

export async function saveDatabase(data: Uint8Array, key = DB_KEY): Promise<void> {
  const idb = await openIDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const old = store.get(manifestKey(key));
      old.onsuccess = () => {
        const previous = typeof old.result === 'number' && Number.isSafeInteger(old.result) ? old.result : 0;
        const count = Math.ceil(data.length / CHUNK_BYTES);
        for (let index = 0; index < count; index++) store.put(data.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES), chunkKey(key, index));
        for (let index = count; index < previous; index++) store.delete(chunkKey(key, index));
        store.put(count, manifestKey(key));
        store.delete(key);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Local save was interrupted'));
      tx.onerror = () => reject(tx.error ?? new Error('Local save failed'));
      old.onerror = () => reject(old.error);
    });
  } finally {
    idb.close();
  }
}
