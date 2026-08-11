const DB_NAME = "health-monitor";
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("foods")) {
        db.createObjectStore("foods", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("exercises")) {
        db.createObjectStore("exercises", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("foodLogs")) {
        const s = db.createObjectStore("foodLogs", { keyPath: "id", autoIncrement: true });
        s.createIndex("byDate", "date");
      }
      if (!db.objectStoreNames.contains("exerciseLogs")) {
        const s = db.createObjectStore("exerciseLogs", { keyPath: "id", autoIncrement: true });
        s.createIndex("byDate", "date");
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeNames, mode);
        const stores = {};
        for (const name of [].concat(storeNames)) stores[name] = transaction.objectStore(name);
        transaction.oncomplete = () => {};
        transaction.onerror = () => reject(transaction.error);
        resolve(stores);
      })
  );
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const db = {
  async getAll(store) {
    const { [store]: s } = await tx(store, "readonly");
    return wrap(s.getAll());
  },
  async get(store, id) {
    const { [store]: s } = await tx(store, "readonly");
    return wrap(s.get(id));
  },
  async add(store, value) {
    const { [store]: s } = await tx(store, "readwrite");
    return wrap(s.add(value));
  },
  async put(store, value) {
    const { [store]: s } = await tx(store, "readwrite");
    return wrap(s.put(value));
  },
  async remove(store, id) {
    const { [store]: s } = await tx(store, "readwrite");
    return wrap(s.delete(id));
  },
  async getAllByIndex(store, indexName, value) {
    const { [store]: s } = await tx(store, "readonly");
    return wrap(s.index(indexName).getAll(value));
  },
  async removeWhere(store, matchFn) {
    const { [store]: s } = await tx(store, "readwrite");
    return new Promise((resolve, reject) => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        if (matchFn(cursor.value)) cursor.delete();
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  },
};
