"use strict";
const { C, Problem } = require("./engine.cjs");
const allowed = [
  C.settings,
  C.bookings,
  C.slots,
  C.members,
  C.audit,
  C.customers,
];
function validateBackup(backup) {
  if (
    backup?.format !== "salon-v2-backup" ||
    backup.version !== 1 ||
    !backup.collections
  )
    throw new Problem(400, "Неверный формат резервной копии");
  for (const c of Object.keys(backup.collections))
    if (!allowed.includes(c)) throw new Problem(400, "Неизвестная коллекция");
  const paths = new Set();
  for (const c of allowed) {
    if (!Array.isArray(backup.collections[c]))
      throw new Problem(400, "Не хватает коллекции " + c);
    for (const row of backup.collections[c]) {
      if (
        !row ||
        typeof row.id !== "string" ||
        !/^[-\w]{1,200}$/.test(row.id) ||
        paths.has(c + "/" + row.id)
      )
        throw new Problem(400, "Неверный или повторный ID");
      paths.add(c + "/" + row.id);
    }
  }
  const bookings = new Map(
    backup.collections[C.bookings].map((b) => [b.id, b]),
  );
  for (const slot of backup.collections[C.slots])
    if (!bookings.has(slot.bookingId))
      throw new Problem(400, "Окно ссылается на отсутствующую запись");
  return backup;
}
async function restoreEmpty(store, backup) {
  validateBackup(backup);
  if (allowed.reduce((n, c) => n + backup.collections[c].length, 0) > 450)
    throw new Problem(
      413,
      "Для большой копии нужен пакетный инструмент восстановления",
    );
  return store.transaction(async (tx) => {
    for (const c of allowed)
      if ((await tx.query(c, [], 1)).length)
        throw new Problem(409, "Восстановление разрешено только в пустую базу");
    for (const c of allowed)
      for (const row of backup.collections[c]) {
        const { id, ...data } = row;
        tx.set(c + "/" + id, data);
      }
    return { restored: true };
  });
}
module.exports = { validateBackup, restoreEmpty, allowed };
