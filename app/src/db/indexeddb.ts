const IDB_NAME = 'nightjar';
const IDB_VERSION = 1;
const IDB_STORE = 'keyval';
const DB_KEY = 'database';

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

export async function loadDatabase(): Promise<Uint8Array | null> {
  const idb = await openIDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const request = store.get(DB_KEY);
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

export async function saveDatabase(data: Uint8Array): Promise<void> {
  const idb = await openIDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const request = store.put(data, DB_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    idb.close();
  }
}
