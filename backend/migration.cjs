"use strict";
const {
  C,
  Problem,
  instant,
  slotTimes,
  normalizePhone,
  validateDate,
} = require("./engine.cjs");
const { createHash } = require("node:crypto");
function prepareLegacy(rows, settings, now = Date.now()) {
  const records = [],
    slots = new Map(),
    issues = [];
  for (const r of rows) {
    const service = settings.services.find((s) => s.name === r.service),
      master = settings.masters.find((m) => m.id === r.masterId);
    if (
      !service ||
      !master ||
      !/^[-\w]{1,128}$/.test(r.id || "") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(r.date || "") ||
      !/^1[0-9]:[03]0$/.test(r.time || "")
    ) {
      issues.push({
        id: r.id,
        issue: "Неизвестная услуга, мастер, дата или время",
      });
      continue;
    }
    if (!["new", "confirmed", "done", "cancelled"].includes(r.status)) {
      issues.push({ id: r.id, issue: "Неизвестный статус" });
      continue;
    }
    // Preserve the actual reserved duration. Never silently stretch old coloring.
    const duration = r.durationMinutes || 30;
    if (![30, 60].includes(duration)) {
      issues.push({ id: r.id, issue: "Проверьте длительность" });
      continue;
    }
    let phone;
    try {
      validateDate(r.date);
      phone = normalizePhone(r.phone).slice(1);
    } catch {
      issues.push({ id: r.id, issue: "Проверьте дату или телефон" });
      continue;
    }
    const customerId = createHash("sha256")
      .update("+" + phone)
      .digest("hex");
    const record = {
      ...r,
      phone: "+" + phone,
      customerId,
      serviceId: service.id,
      masterName: master.name,
      durationMinutes: duration,
      price: service.price,
      startsAt: instant(r.date, r.time, settings.timezone),
      version: 1,
      createdAt: typeof r.createdAt === "number" ? r.createdAt : now,
      updatedAt: now,
      legacy: true,
      // Legacy pending appointments stay reserved until reviewed, not auto-expired on import.
      expiresAt:
        r.status === "new"
          ? Math.max(
              now + 72 * 3600000,
              instant(r.date, r.time, settings.timezone),
            )
          : 0,
    };
    for (const time of ["new", "confirmed"].includes(record.status)
      ? slotTimes(record)
      : []) {
      const key = `${record.masterId}_${record.date}_${time}`;
      if (slots.has(key))
        issues.push({
          id: r.id,
          issue: "Пересечение с " + slots.get(key).bookingId + " в " + key,
        });
      else
        slots.set(key, {
          id: key,
          bookingId: r.id,
          masterId: r.masterId,
          date: r.date,
          time,
        });
    }
    records.push(record);
  }
  if (issues.length)
    throw new Problem(409, JSON.stringify({ migrationBlocked: true, issues }));
  return {
    records,
    slots: [...slots.values()],
    needsDurationReview: records
      .filter(
        (r) =>
          r.service === "Окрашивание в один тон" &&
          r.durationMinutes !== 60 &&
          ["new", "confirmed"].includes(r.status),
      )
      .map((r) => r.id),
  };
}
async function importLegacy(store, prepared, settings) {
  return store.transaction(async (tx) => {
    for (const c of [C.bookings, C.slots, C.customers, C.settings])
      if ((await tx.query(c, [], 1)).length)
        throw new Problem(409, "Импорт разрешён только в пустую V2-базу");
    if (prepared.records.length + prepared.slots.length > 300)
      throw new Problem(
        413,
        "Для крупного импорта используйте отдельную миграцию с пакетами и контрольными точками",
      );
    const customers = new Map();
    for (const b of prepared.records)
      customers.set(b.customerId, {
        name: b.name,
        phone: b.phone,
        notes: "",
        updatedAt: b.updatedAt,
      });
    tx.set(C.settings + "/settings", settings);
    for (const b of prepared.records) tx.set(C.bookings + "/" + b.id, b);
    for (const slot of prepared.slots) {
      const { id, ...data } = slot;
      tx.set(C.slots + "/" + id, data);
    }
    for (const [id, c] of customers) tx.set(C.customers + "/" + id, c);
    return {
      bookings: prepared.records.length,
      review: prepared.needsDurationReview,
    };
  });
}
module.exports = { prepareLegacy, importLegacy };
