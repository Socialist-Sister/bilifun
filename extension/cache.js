(function (root) {
  "use strict";
  const NAME = "lens-cache-v1",
    TTL = 15 * 60 * 1000;
  let pending;
  function database() {
    if (!root.indexedDB) return Promise.resolve(null);
    if (!pending)
      pending = new Promise((resolve, reject) => {
        const open = indexedDB.open(NAME, 1);
        open.onupgradeneeded = () =>
          open.result.createObjectStore("segments", { keyPath: "key" });
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(new Error("弹幕缓存不可用"));
      });
    return pending;
  }
  async function get(key) {
    const db = await database();
    if (!db) return null;
    return new Promise((resolve) => {
      const req = db.transaction("segments").objectStore("segments").get(key);
      req.onsuccess = () =>
        resolve(
          req.result && Date.now() - req.result.time < TTL
            ? req.result.rows
            : null,
        );
      req.onerror = () => resolve(null);
    });
  }
  async function put(key, rows) {
    const db = await database();
    if (!db) return;
    if (new TextEncoder().encode(JSON.stringify(rows)).length > 2 * 1024 * 1024)
      return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("segments", "readwrite"),
        store = tx.objectStore("segments");
      store.put({ key, time: Date.now(), rows });
      const req = store.getAll();
      req.onsuccess = () => {
        const records = req.result.sort((a, b) => b.time - a.time);
        for (const record of records.slice(20)) store.delete(record.key);
        for (const record of records)
          if (Date.now() - record.time >= TTL) store.delete(record.key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error("缓存写入失败"));
    });
  }
  async function clear() {
    const db = await database();
    if (!db) return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("segments", "readwrite");
      tx.objectStore("segments").clear();
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
  }
  root.LensCache = Object.freeze({ get, put, clear });
})(globalThis);
