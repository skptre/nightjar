const IDB_NAME = 'nightjar';
const IDB_VERSION = 1;
const IDB_STORE = 'keyval';
const DB_KEY = 'database';
export async function clearRecoveryStorage(): Promise<void> {
  const idb = await openIDB();
  try {
    await new Promise<void>((resolve,reject) => {
      const tx = idb.transaction(IDB_STORE,'readwrite');
      for (const key of ['workspace-daily','workspace-before-update','workspace-before-restore','before-migration']) tx.objectStore(IDB_STORE).delete(key);
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
      const request = store.get(key);
      request.onsuccess = () => {
        const result: unknown = request.result;
        resolve(result instanceof Uint8Array ? result : null);
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
      const request = store.put(data, key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Local save was interrupted'));
      tx.onerror = () => reject(tx.error ?? new Error('Local save failed'));
      request.onerror = () => reject(request.error);
    });
  } finally {
    idb.close();
  }
}
