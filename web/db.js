// Minimal IndexedDB wrapper: "kv" (settings, tokens) and "history" (takes with audio blobs).
const DB_NAME = "grokvoice";
let dbp;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("kv");
        db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        Promise.resolve(fn(s)).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const kv = {
  get: (k) => tx("kv", "readonly", (s) => req2p(s.get(k))),
  set: (k, v) => tx("kv", "readwrite", (s) => { s.put(v, k); }),
  del: (k) => tx("kv", "readwrite", (s) => { s.delete(k); }),
};

export const history = {
  async add(entry) {
    return tx("history", "readwrite", (s) => req2p(s.add(entry)));
  },
  async put(entry) {
    return tx("history", "readwrite", (s) => { s.put(entry); });
  },
  async get(id) {
    return tx("history", "readonly", (s) => req2p(s.get(id)));
  },
  async del(id) {
    return tx("history", "readwrite", (s) => { s.delete(id); });
  },
  async clear() {
    return tx("history", "readwrite", (s) => { s.clear(); });
  },
  async list() {
    const all = await tx("history", "readonly", (s) => req2p(s.getAll()));
    return all.sort((a, b) => b.id - a.id);
  },
  async trim(max) {
    const all = await this.list();
    for (const e of all.slice(max)) await this.del(e.id);
  },
};
