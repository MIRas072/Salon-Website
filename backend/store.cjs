"use strict";
// Firestore rejects arrays directly nested in arrays (our shift intervals).
// Store interval arrays inside a map and decode at the adapter boundary.
function encode(value) {
  if (Array.isArray(value))
    return value.map((x) =>
      Array.isArray(x) ? { __salonNestedArray: x.map(encode) } : encode(x),
    );
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, encode(v)]),
    );
  return value;
}
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if (
      Object.keys(value).length === 1 &&
      Array.isArray(value.__salonNestedArray)
    )
      return value.__salonNestedArray.map(decode);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, decode(v)]),
    );
  }
  return value;
}
// Both adapters expose the same atomic document transaction contract.
class SQLiteStore {
  constructor(filename = ":memory:") {
    const { DatabaseSync } = require("node:sqlite");
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS documents (path TEXT PRIMARY KEY, collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS collection_idx ON documents(collection,id)",
    );
    this.tail = Promise.resolve();
  }
  async transaction(fn) {
    const run = this.tail.then(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const pending = new Map();
        const tx = {
          get: async (p) => {
            const r = this.db
              .prepare("SELECT data FROM documents WHERE path=?")
              .get(p);
            return r ? JSON.parse(r.data) : null;
          },
          query: async (c, filters = [], limit = 1000, after = "") => {
            const range = filters.find((f) => f[1] !== "==")?.[0];
            let rows = this.db
              .prepare(
                "SELECT id,data FROM documents WHERE collection=? ORDER BY id",
              )
              .all(c)
              .map((r) => ({ id: r.id, ...JSON.parse(r.data) }))
              .filter((r) =>
                filters.every(([key, op, value]) =>
                  op === "=="
                    ? r[key] === value
                    : op === ">="
                      ? r[key] >= value
                      : r[key] <= value,
                ),
              );
            if (range)
              rows.sort(
                (a, b) =>
                  String(a[range]).localeCompare(String(b[range])) ||
                  a.id.localeCompare(b.id),
              );
            if (after) {
              const index = rows.findIndex((r) => r.id === after);
              rows = index < 0 ? [] : rows.slice(index + 1);
            }
            return rows.slice(0, limit);
          },
          set: (p, d) => pending.set(p, d),
          delete: (p) => pending.set(p, null),
        };
        const result = await fn(tx);
        for (const [p, d] of pending) {
          if (d === null)
            this.db.prepare("DELETE FROM documents WHERE path=?").run(p);
          else {
            const [c, id] = p.split("/");
            this.db
              .prepare("INSERT OR REPLACE INTO documents VALUES (?,?,?,?)")
              .run(p, c, id, JSON.stringify(d));
          }
        }
        this.db.exec("COMMIT");
        return result;
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    });
    this.tail = run.catch(() => {});
    return run;
  }
  close() {
    this.db.close();
  }
}
class FirestoreStore {
  constructor(db) {
    this.db = db;
  }
  transaction(fn) {
    return this.db.runTransaction(async (native) => {
      const tx = {
        get: async (p) => {
          const s = await native.get(this.db.doc(p));
          return s.exists ? decode(s.data()) : null;
        },
        query: async (c, filters = [], limit = 1000, after = "") => {
          let q = this.db.collection(c);
          for (const [k, op, v] of filters) q = q.where(k, op, v);
          const range = filters.find((f) => f[1] !== "==")?.[0];
          if (range) q = q.orderBy(range);
          q = q.orderBy("__name__").limit(limit);
          if (after) {
            const cursor = await native.get(this.db.doc(c + "/" + after));
            if (!cursor.exists) return [];
            q = q.startAfter(cursor);
          }
          const s = await native.get(q);
          return s.docs.map((d) => ({ id: d.id, ...decode(d.data()) }));
        },
        set: (p, d) => native.set(this.db.doc(p), encode(d)),
        delete: (p) => native.delete(this.db.doc(p)),
      };
      return fn(tx);
    });
  }
}
module.exports = { SQLiteStore, FirestoreStore };
