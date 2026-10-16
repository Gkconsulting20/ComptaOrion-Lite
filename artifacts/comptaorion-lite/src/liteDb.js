const DB_NAME = 'comptaorion-lite';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'opId' });
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function queueWrite(scope, opId, endpoint, payload) {
  const db = await openDb();
  const item = { opId, scope, endpoint, payload, createdAt: Date.now() };
  return new Promise((resolve, reject) => {
    const tx = db.transaction('queue', 'readwrite');
    const store = tx.objectStore('queue');
    const existingRequest = store.get(opId);
    existingRequest.onsuccess = () => {
      try {
        assertQueueOwnership(existingRequest.result, scope);
        store.put(item);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
    existingRequest.onerror = () => reject(existingRequest.error);
    tx.oncomplete = () => resolve(item);
    tx.onerror = () => reject(tx.error);
  });
}

export function assertQueueOwnership(item, scope) {
  if (item && item.scope !== scope) {
    throw new Error('Cette opération hors ligne appartient à une autre entreprise');
  }
}

export async function listQueue(scope) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('queue').objectStore('queue').getAll();
    req.onsuccess = () => resolve((req.result || []).filter(item => item.scope === scope));
    req.onerror = () => reject(req.error);
  });
}

export async function removeQueue(scope, opId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('queue', 'readwrite');
    const store = tx.objectStore('queue');
    const request = store.get(opId);
    request.onsuccess = () => {
      try {
        assertQueueOwnership(request.result, scope);
        if (request.result) store.delete(opId);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function cacheRead(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction('cache').objectStore('cache').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

export async function cacheWrite(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('cache', 'readwrite');
      tx.objectStore('cache').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* IndexedDB is optional */ }
}