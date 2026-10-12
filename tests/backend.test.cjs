"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { SQLiteStore, FirestoreStore } = require("../backend/store.cjs"),
  { Engine, C } = require("../backend/engine.cjs"),
  { handler } = require("../backend/http.cjs");
const owner = {
  uid: "owner",
  email: "jokkerazirali@gmail.com",
  emailVerified: true,
};
async function setup() {
  let store;
  if (process.env.SALON_TEST_FIRESTORE === "1") {
    const { initializeApp } = require("firebase-admin/app"),
      { getFirestore } = require("firebase-admin/firestore");
    const id = "demo-test-" + crypto.randomUUID();
    const db = getFirestore(initializeApp({ projectId: id }, id));
    store = new FirestoreStore(db);
    store.close = () => db.terminate();
  } else store = new SQLiteStore();
  let now = Date.parse("2026-10-12T06:00:00Z");
  const e = new Engine(store, { now: () => now });
  const s = (await e.adminSettings(owner)).settings;
  s.privacyApproved = true;
  s.durationsApproved = true;
  await e.saveSettings(owner, s);
  return { e, store, advance: (ms) => (now += ms) };
}
const booking = (overrides = {}) => ({
  requestId: crypto.randomUUID(),
  name: "Тест",
  phone: "+77771234567",
  serviceId: "service-3",
  masterId: "master-1",
  date: "2026-10-13",
  time: "16:00",
  consent: true,
  ...overrides,
});
test("concurrent hour and second-half bookings: exactly one wins; no partial rows", async () => {
  const { e, store } = await setup();
  const results = await Promise.allSettled([
    e.create(booking()),
    e.create(
      booking({ time: "16:30", serviceId: "service-1", phone: "+77771234568" }),
    ),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  const rows = await store.transaction((tx) => tx.query(C.bookings));
  assert.equal(rows.length, 1);
  const slots = await store.transaction((tx) => tx.query(C.slots));
  assert.equal(slots.length, rows[0].durationMinutes / 30);
  store.close();
});
test("schedule day off, lunch gaps, ending at close and wrong master blocked server-side", async () => {
  const { e, store } = await setup();
  await e.shift(owner, {
    date: "2026-10-13",
    masterId: "master-1",
    windows: [
      ["10:00", "13:00"],
      ["14:00", "18:00"],
    ],
  });
  await assert.rejects(e.create(booking({ time: "12:30" })), { status: 409 });
  await assert.rejects(e.create(booking({ time: "17:30" })), { status: 409 });
  await assert.rejects(e.create(booking({ masterId: "master-3" })), {
    status: 400,
  });
  const a = await e.availability("master-1", "2026-10-13", "service-3");
  assert.equal(a.slots.find((s) => s.time === "12:30").available, false);
  assert(!a.slots.some((s) => s.time === "13:00"));
  await e.shift(owner, {
    date: "2026-10-13",
    masterId: "master-1",
    windows: [],
  });
  assert.equal(
    (await e.availability("master-1", "2026-10-13", "service-3")).slots.length,
    0,
  );
  store.close();
});
test("invalid date, past, far future, consent and draft privacy cannot bypass UI", async () => {
  const { e, store } = await setup();
  for (const b of [
    booking({ date: "2026-02-30" }),
    booking({ date: "2026-10-01" }),
    booking({ date: "2028-10-01" }),
    booking({ consent: false }),
  ])
    await assert.rejects(e.create(b), { status: 400 });
  const s = (await e.adminSettings(owner)).settings;
  s.privacyApproved = false;
  await e.saveSettings(owner, s);
  await assert.rejects(e.create(booking()), { status: 503 });
  store.close();
});
test("expired pending windows release, new reservation cannot be freed by late cancel", async () => {
  const { e, store, advance } = await setup();
  const first = await e.create(booking());
  advance(5 * 3600000);
  assert(
    (await e.availability("master-1", "2026-10-13", "service-3")).slots.find(
      (s) => s.time === "16:00",
    ).available,
  );
  const second = await e.create(booking({ phone: "+77771234568" }));
  await assert.rejects(e.cancel(first.id, first.cancelToken), { status: 409 });
  assert.equal(
    (
      await store.transaction((tx) =>
        tx.get(C.slots + "/master-1_2026-10-13_16:00"),
      )
    ).bookingId,
    second.id,
  );
  store.close();
});
test("confirmation, overlap move, stale write rejection and cancellation release entire interval", async () => {
  const { e, store } = await setup();
  const b = await e.create(booking());
  await e.update(b.id, { status: "confirmed", version: 1 }, owner);
  await assert.rejects(
    e.update(b.id, { status: "cancelled", version: 1 }, owner),
    { status: 409 },
  );
  await e.update(b.id, { time: "16:30", version: 2 }, owner);
  let slots = await store.transaction((tx) => tx.query(C.slots));
  assert.deepEqual(slots.map((s) => s.time).sort(), ["16:30", "17:00"]);
  await e.cancel(b.id, b.cancelToken);
  slots = await store.transaction((tx) => tx.query(C.slots));
  assert.equal(slots.length, 0);
  await assert.rejects(e.cancel(b.id, "wrong"), { status: 404 });
  store.close();
});
test("idempotency prevents repeated bookings and payments; refunds cannot go below zero", async () => {
  const { e, store } = await setup();
  const data = booking();
  const first = await e.create(data);
  assert.equal((await e.create(data)).id, first.id);
  await assert.rejects(e.create({ ...data, time: "17:00" }), { status: 409 });
  const pay = { requestId: "p1", amount: 6000, method: "cash" };
  await e.payment(owner, first.id, pay);
  const repeated = await e.payment(owner, first.id, pay);
  assert.equal(repeated.payments.length, 1);
  await assert.rejects(
    e.payment(owner, first.id, { ...pay, requestId: "p2", amount: -7000 }),
    { status: 400 },
  );
  await e.payment(owner, first.id, { ...pay, requestId: "p2", amount: -6000 });
  assert.equal(
    (
      await e.list(owner, { from: "2026-10-13", to: "2026-10-13" })
    ).items[0].payments.reduce((n, p) => n + p.amount, 0),
    0,
  );
  store.close();
});
test("server-side rate limit applies across new request IDs", async () => {
  const { e, store } = await setup();
  for (let i = 0; i < 5; i++)
    await e.create(booking({ time: "10:00", date: "2026-10-" + (13 + i) }));
  await assert.rejects(
    e.create(booking({ time: "10:00", date: "2026-10-19" })),
    { status: 429 },
  );
  store.close();
});
test("roles enforce owner access; unverified owner email is insufficient; master sees only own records", async () => {
  const { e, store } = await setup();
  await assert.rejects(e.adminSettings({ ...owner, emailVerified: false }), {
    status: 403,
  });
  await e.members(owner, { uid: "staff", role: "receptionist", active: true });
  const staff = { uid: "staff" };
  await assert.rejects(e.export(staff), { status: 403 });
  await assert.rejects(
    e.saveSettings(staff, (await e.adminSettings(owner)).settings),
    { status: 403 },
  );
  await e.members(owner, {
    uid: "master",
    role: "master",
    masterId: "master-1",
    active: true,
  });
  const b = await e.create(booking());
  await e.create(booking({ masterId: "master-2", phone: "+77771234568" }));
  const own = (
    await e.list({ uid: "master" }, { from: "2026-10-13", to: "2026-10-13" })
  ).items;
  assert.equal(own.length, 1);
  await assert.rejects(
    e.update(
      b.id,
      { time: "17:00", status: "done", version: 1 },
      { uid: "master" },
    ),
    { status: 403 },
  );
  await e.members(owner, { uid: "staff", role: "receptionist", active: false });
  await assert.rejects(e.adminSettings(staff), { status: 403 });
  store.close();
});
test("changing catalog preserves reserved duration and price; inactive service can still be cancelled", async () => {
  const { e, store } = await setup();
  const b = await e.create(booking());
  const s = (await e.adminSettings(owner)).settings;
  s.services[2].duration = 120;
  s.services[2].price = 20000;
  s.services[2].active = false;
  await e.saveSettings(owner, s);
  const confirmed = await e.update(
    b.id,
    { status: "confirmed", version: 1 },
    owner,
  );
  assert.equal(confirmed.durationMinutes, 60);
  assert.equal(confirmed.price, 6000);
  await e.update(b.id, { status: "cancelled", version: 2 }, owner);
  assert.equal((await store.transaction((tx) => tx.query(C.slots))).length, 0);
  store.close();
});
test("shifts reject stranding booked clients; backups include history, customer notes and settings", async () => {
  const { e, store } = await setup();
  const b = await e.create(booking());
  await assert.rejects(
    e.shift(owner, { date: "2026-10-13", masterId: "master-1", windows: [] }),
    { status: 409 },
  );
  const customers = await e.customers(owner);
  await e.customer(owner, customers.items[0].id, "Предпочитает утро");
  const backup = await e.export(owner);
  assert.equal(backup.collections[C.customers][0].notes, "Предпочитает утро");
  assert(backup.collections[C.audit].length >= 3);
  assert.equal(backup.collections[C.bookings][0].id, b.id);
  store.close();
});
test("API rejects unauthenticated admin, validates IDs and handles Netlify rewritten paths", async () => {
  const { e, store } = await setup();
  const api = handler(e, async () => {
    throw Object.assign(new Error("Войдите"), { status: 401 });
  });
  assert.equal(
    (await api({ method: "GET", path: "/api/v2/admin/export" })).status,
    401,
  );
  assert.equal(
    (
      await api({
        method: "GET",
        path: "/.netlify/functions/salon-api/api/v2/catalog",
      })
    ).status,
    200,
  );
  assert.equal(
    (await api({ method: "POST", path: "/api/v2/cancel/../../bad", body: {} }))
      .status,
    400,
  );
  store.close();
});
test("owner anonymizes closed customer history, active visits and staff deletion blocked", async () => {
  const { e, store } = await setup();
  const b = await e.create(booking());
  const id = (await e.customers(owner)).items[0].id;
  await assert.rejects(e.anonymize(owner, id), { status: 409 });
  await e.members(owner, { uid: "staff", role: "receptionist", active: true });
  await assert.rejects(e.anonymize({ uid: "staff" }, id), { status: 403 });
  await e.cancel(b.id, b.cancelToken);
  await e.anonymize(owner, id);
  assert.equal((await e.customers(owner)).items.length, 0);
  const record = await store.transaction((tx) =>
    tx.get(C.bookings + "/" + b.id),
  );
  assert.equal(record.phone, "");
  assert.equal(record.cancelHash, null);
  store.close();
});
test("pending inbox includes future requests outside selected period without leaking cancellation hash", async () => {
  const { e, store } = await setup();
  await e.create(booking({ date: "2026-11-20" }));
  assert.equal(
    (await e.list(owner, { from: "2026-10-12", to: "2026-10-26" })).items
      .length,
    0,
  );
  const inbox = await e.pending(owner);
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].cancelHash, undefined);
  store.close();
});
