"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { SQLiteStore } = require("../backend/store.cjs"),
  { Engine, C } = require("../backend/engine.cjs"),
  { restoreEmpty } = require("../backend/backup.cjs"),
  { prepareLegacy, importLegacy } = require("../backend/migration.cjs"),
  defaults = require("../backend/defaults.cjs");
const owner = {
  uid: "owner",
  email: "jokkerazirali@gmail.com",
  emailVerified: true,
};
function makeStore() {
  if (process.env.SALON_TEST_FIRESTORE !== "1") return new SQLiteStore();
  const { initializeApp } = require("firebase-admin/app"),
    { getFirestore } = require("firebase-admin/firestore"),
    { FirestoreStore } = require("../backend/store.cjs");
  const id = "demo-storage-" + crypto.randomUUID();
  const db = getFirestore(initializeApp({ projectId: id }, id)),
    store = new FirestoreStore(db);
  store.close = () => db.terminate();
  return store;
}
test("backup restores into empty DB and rejects overwriting existing data", async () => {
  const first = makeStore(),
    second = makeStore(),
    e = new Engine(first);
  const s = (await e.adminSettings(owner)).settings;
  await e.saveSettings(owner, s);
  const data = await e.export(owner);
  await restoreEmpty(second, data);
  assert.deepEqual(
    await new Engine(second).export(owner).then((x) => x.collections),
    data.collections,
  );
  await assert.rejects(restoreEmpty(second, data), { status: 409 });
  await assert.rejects(
    restoreEmpty(new SQLiteStore(), {
      ...data,
      collections: { ...data.collections, private: [{ id: "x" }] },
    }),
    { status: 400 },
  );
  first.close();
  second.close();
});
test("legacy import preserves 30-minute old coloring and blocks overlap before any writes", async () => {
  const settings = { ...structuredClone(defaults), version: 1 };
  const base = {
    id: "legacy-one",
    name: "Клиент",
    phone: "87771234567",
    masterId: "master-1",
    date: "2026-10-20",
    time: "16:00",
    service: "Окрашивание в один тон",
    status: "confirmed",
  };
  const prepared = prepareLegacy([base], settings);
  assert.equal(prepared.records[0].durationMinutes, 30);
  assert.deepEqual(prepared.needsDurationReview, ["legacy-one"]);
  assert.throws(
    () => prepareLegacy([base, { ...base, id: "duplicate" }], settings),
    { status: 409 },
  );
  const store = new SQLiteStore();
  await importLegacy(store, prepared, settings);
  assert.equal(
    (await store.transaction((tx) => tx.query(C.bookings))).length,
    1,
  );
  await assert.rejects(importLegacy(store, prepared, settings), {
    status: 409,
  });
  store.close();
});
test("notification transport stays off without configuration; cancellation prevents stale reminder", async () => {
  const { deliver } = require("../backend/notifications.cjs");
  const store = new SQLiteStore(),
    e = new Engine(store, { now: () => Date.parse("2026-10-12T06:00:00Z") });
  const s = (await e.adminSettings(owner)).settings;
  s.privacyApproved = true;
  await e.saveSettings(owner, s);
  const b = await e.create({
    requestId: "reminder-test",
    name: "Тест",
    phone: "+77771234567",
    email: "test@example.test",
    serviceId: "service-1",
    masterId: "master-1",
    date: "2026-10-13",
    time: "10:00",
    consent: true,
  });
  await e.update(b.id, { status: "confirmed", version: 1 }, owner);
  assert.equal((await deliver(e)).enabled, false);
  const notifications = await store.transaction((tx) =>
    tx.query(C.notifications),
  );
  assert(notifications.some((n) => n.type === "reminder"));
  await e.cancel(b.id, b.cancelToken);
  assert.equal(
    (await store.transaction((tx) => tx.get(C.bookings + "/" + b.id))).status,
    "cancelled",
  );
  store.close();
});
