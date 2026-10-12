"use strict";
const { C, active } = require("./engine.cjs");
// Optional transport: no external messages are sent unless all delivery settings exist.
async function deliver(engine) {
  if (
    !process.env.RESEND_API_KEY ||
    !process.env.MAIL_FROM ||
    !process.env.ADMIN_NOTIFICATION_EMAIL
  )
    return { enabled: false, sent: 0 };
  const claimed = await engine.store.transaction(async (tx) => {
    const rows = await tx.query(
        C.notifications,
        [
          ["status", "==", "pending"],
          ["dueAt", "<=", engine.now()],
        ],
        30,
      ),
      result = [];
    for (const n of rows) {
      const b = await tx.get(C.bookings + "/" + n.bookingId);
      if (
        !b ||
        !active(b, engine.now()) ||
        (n.type === "reminder" &&
          (b.status !== "confirmed" ||
            b.startsAt !== n.startsAt ||
            b.startsAt <= engine.now() ||
            b.reminderKey !== n.id))
      ) {
        result.push({ n, skip: true });
        continue;
      }
      if (n.attempts >= 5) {
        result.push({ n, skip: true });
        continue;
      }
      result.push({ n, b });
    }
    for (const r of result) {
      if (r.skip)
        tx.set(C.notifications + "/" + r.n.id, { ...r.n, status: "skipped" });
    }
    return result.filter((r) => !r.skip);
  });
  let sent = 0;
  const settings = await engine.catalog();
  for (const { n, b } of claimed) {
    const reminder = n.type === "reminder";
    const message = reminder
      ? `Напоминаем о записи: ${b.service}, ${b.date} ${b.time}, ${b.masterName}. ${settings.name}, ${settings.address}. Телефон: ${settings.phone}. Для изменения записи свяжитесь с салоном.`
      : `Новая заявка: ${b.service}, ${b.date} ${b.time}, ${b.masterName}. Откройте кабинет: ${process.env.SITE_URL}/next/admin.html`;
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.RESEND_API_KEY,
          "Content-Type": "application/json",
          "Idempotency-Key": "salon-notification-" + n.id,
        },
        body: JSON.stringify({
          from: process.env.MAIL_FROM,
          to: [reminder ? b.email : process.env.ADMIN_NOTIFICATION_EMAIL],
          subject: reminder ? "Напоминание о записи" : "Новая заявка в салон",
          text: message,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("delivery");
      await engine.store.transaction(async (tx) => {
        const current = await tx.get(C.notifications + "/" + n.id);
        if (current?.status === "pending")
          tx.set(C.notifications + "/" + n.id, {
            ...current,
            status: "sent",
            sentAt: engine.now(),
            attempts: current.attempts + 1,
          });
      });
      sent++;
    } catch {
      await engine.store.transaction(async (tx) => {
        const current = await tx.get(C.notifications + "/" + n.id);
        if (current?.status === "pending")
          tx.set(C.notifications + "/" + n.id, {
            ...current,
            attempts: current.attempts + 1,
            lastAttemptAt: engine.now(),
          });
      });
    }
  }
  return { enabled: true, sent };
}
module.exports = { deliver };
