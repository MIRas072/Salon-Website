"use strict";
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const defaults = require("./defaults.cjs");
const C = {
  settings: "salonV2",
  bookings: "bookingsV2",
  slots: "availabilityV2",
  members: "membersV2",
  audit: "auditV2",
  customers: "customersV2",
  rates: "rateLimitsV2",
  requests: "requestsV2",
  notifications: "notificationsV2",
};
class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new Problem(status, message);
};
const hash = (s) => createHash("sha256").update(s).digest("hex");
const minutes = (t) => {
  if (typeof t !== "string" || !/^([01]\d|2[0-3]):[03]0$/.test(t))
    fail(400, "Время должно быть с шагом 30 минут");
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
};
const clock = (n) =>
  String(Math.floor(n / 60)).padStart(2, "0") +
  ":" +
  String(n % 60).padStart(2, "0");
function dateValid(d) {
  if (
    typeof d !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
    !Number.isFinite(Date.parse(d)) ||
    new Date(d + "T12:00:00Z").toISOString().slice(0, 10) !== d
  )
    fail(400, "Некорректная дата");
  return d;
}
function local(now, tz) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
}
function instant(date, time, tz) {
  let n = Date.parse(date + "T" + time + ":00Z");
  const desired = n;
  for (let i = 0; i < 3; i++) {
    const p = local(n, tz);
    n +=
      desired -
      Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
  }
  return n;
}
function cleanText(v, max, label) {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max)
    fail(400, label);
  return v.trim();
}
function phone(v) {
  let s = String(v || "").replace(/[^\d]/g, "");
  if (s.length === 11 && s[0] === "8") s = "7" + s.slice(1);
  if (s.length === 10) s = "7" + s;
  if (!/^\d{10,15}$/.test(s)) fail(400, "Введите корректный телефон");
  return "+" + s;
}
const active = (b, now) =>
  b && (b.status === "confirmed" || (b.status === "new" && b.expiresAt > now));
const slotKey = (b, t) => `${b.masterId}_${b.date}_${t}`;
const slotTimes = (b) =>
  Array.from({ length: b.durationMinutes / 30 }, (_, i) =>
    clock(minutes(b.time) + i * 30),
  );
function validateSettings(s) {
  s = structuredClone(s);
  s.name = cleanText(s.name, 100, "Название салона");
  s.address = cleanText(s.address, 200, "Адрес");
  s.phone = phone(s.phone);
  try {
    new Intl.DateTimeFormat("ru", { timeZone: s.timezone });
  } catch {
    fail(400, "Неверный часовой пояс");
  }
  for (const [k, lo, hi] of [
    ["pendingHours", 1, 72],
    ["horizonDays", 1, 365],
    ["leadMinutes", 0, 1440],
    ["reminderHours", 1, 72],
  ])
    if (!Number.isInteger(s[k]) || s[k] < lo || s[k] > hi)
      fail(400, "Неверная настройка " + k);
  if (
    !Array.isArray(s.services) ||
    s.services.length < 1 ||
    s.services.length > 100 ||
    !Array.isArray(s.masters) ||
    s.masters.length < 1 ||
    s.masters.length > 50
  )
    fail(400, "Неверный каталог");
  for (const a of [s.services, s.masters]) {
    const ids = new Set();
    for (const x of a) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(x.id) || ids.has(x.id))
        fail(400, "Неверный или повторный ID");
      ids.add(x.id);
      x.name = cleanText(x.name, 100, "Название");
      if (typeof x.active !== "boolean") fail(400, "Укажите активность");
    }
  }
  for (const x of s.services)
    if (
      !Number.isInteger(x.duration) ||
      x.duration < 30 ||
      x.duration > 480 ||
      x.duration % 30 ||
      !Number.isInteger(x.price) ||
      x.price < 0 ||
      x.price > 10000000
    )
      fail(400, "Длительность: 30–480 минут, цена: целое число");
  if (!s.weekly || typeof s.weekly !== "object" || Array.isArray(s.weekly))
    fail(400, "Укажите недельный график мастеров");
  for (const m of s.masters) {
    if (
      !Array.isArray(m.services) ||
      m.services.some((id) => !s.services.some((x) => x.id === id))
    )
      fail(400, "Неизвестная услуга мастера");
    if (
      !s.weekly[m.id] ||
      typeof s.weekly[m.id] !== "object" ||
      Array.isArray(s.weekly[m.id])
    )
      fail(400, "Укажите недельный график каждого мастера");
    for (let d = 0; d < 7; d++) validateWindows(s.weekly[m.id][d] ?? []);
  }
  if (
    typeof s.privacyText !== "string" ||
    s.privacyText.length > 30000 ||
    typeof s.privacyApproved !== "boolean" ||
    typeof s.durationsApproved !== "boolean"
  )
    fail(400, "Проверьте политику и длительности");
  s.privacyVersion = cleanText(s.privacyVersion, 50, "Версия политики");
  s.turnstileSiteKey = String(s.turnstileSiteKey || "").slice(0, 100);
  return s;
}
function validateWindows(w) {
  if (!Array.isArray(w) || w.length > 8) fail(400, "Неверные смены");
  let previous = -1;
  for (const range of w) {
    if (!Array.isArray(range) || range.length !== 2)
      fail(400, "Неверная смена");
    const a = minutes(range[0]),
      b = range[1] === "24:00" ? 1440 : minutes(range[1]);
    if (a >= b || a < previous)
      fail(400, "Смены пересекаются или указаны неверно");
    previous = b;
  }
  return w;
}
function bookingData(input, s, now, isPublic) {
  const service = s.services.find((x) => x.id === input.serviceId && x.active),
    master = s.masters.find((x) => x.id === input.masterId && x.active);
  if (!service || !master || !master.services.includes(service.id))
    fail(400, "Мастер не оказывает выбранную услугу");
  const date = dateValid(input.date);
  minutes(input.time);
  const startsAt = instant(date, input.time, s.timezone);
  if (
    isPublic &&
    (startsAt < now + s.leadMinutes * 60000 ||
      startsAt > now + s.horizonDays * 86400000)
  )
    fail(400, "Выберите время в допустимом периоде");
  const status = isPublic ? "new" : input.status || "confirmed";
  if (!["new", "confirmed", "done", "cancelled", "no-show"].includes(status))
    fail(400, "Неверный статус");
  if (!isPublic && ["new", "confirmed"].includes(status) && startsAt < now)
    fail(400, "Нельзя создавать активную запись в прошлом");
  if (isPublic && input.consent !== true)
    fail(400, "Подтвердите согласие на обработку данных");
  return {
    name: cleanText(input.name, 80, "Введите имя"),
    phone: phone(input.phone),
    serviceId: service.id,
    service: service.name,
    masterId: master.id,
    masterName: master.name,
    date,
    time: input.time,
    durationMinutes: service.duration,
    price: service.price,
    startsAt,
    status,
    comment: String(input.comment || "")
      .trim()
      .slice(0, 300),
    source: isPublic ? "site" : "admin",
    expiresAt: now + s.pendingHours * 3600000,
    consentVersion: isPublic ? s.privacyVersion : null,
    email: input.email ? cleanText(input.email, 254, "Неверная почта") : "",
  };
}
class Engine {
  constructor(
    store,
    {
      now = () => Date.now(),
      ownerEmail = process.env.SALON_OWNER_EMAIL || "jokkerazirali@gmail.com",
      ownerUid = process.env.SALON_OWNER_UID,
    } = {},
  ) {
    this.store = store;
    this.now = now;
    this.ownerEmail = ownerEmail;
    this.ownerUid = ownerUid;
  }
  async settings(tx) {
    return (
      (await tx.get(C.settings + "/settings")) || {
        ...structuredClone(defaults),
        version: 1,
      }
    );
  }
  async role(tx, user) {
    if (!user) fail(401, "Войдите в кабинет");
    if (
      (this.ownerUid && user.uid === this.ownerUid) ||
      (user.email === this.ownerEmail && user.emailVerified)
    )
      return { role: "owner", uid: user.uid };
    const m = await tx.get(C.members + "/" + user.uid);
    if (!m || !m.active) fail(403, "Нет доступа к салону");
    return { ...m, uid: user.uid };
  }
  permit(role, allowed) {
    if (!allowed.includes(role.role)) fail(403, "Недостаточно прав");
  }
  audit(tx, user, action, id, changes = {}) {
    tx.set(C.audit + "/" + this.now() + "_" + randomUUID(), {
      actor: user.uid,
      action,
      recordId: id,
      changes,
      createdAt: this.now(),
    });
  }
  async catalog() {
    return this.store.transaction(async (tx) => {
      const s = await this.settings(tx);
      return {
        ...s,
        weekly: undefined,
        services: s.services.filter((x) => x.active),
        masters: s.masters.filter((x) => x.active),
      };
    });
  }
  async windows(tx, s, masterId, date) {
    const override = await tx.get(C.settings + `/shift_${masterId}_${date}`);
    return override
      ? override.windows
      : s.weekly[masterId]?.[new Date(date + "T12:00:00Z").getUTCDay()] || [];
  }
  async availability(masterId, date, serviceId) {
    dateValid(date);
    return this.store.transaction(async (tx) => {
      const s = await this.settings(tx),
        service = s.services.find((x) => x.id === serviceId && x.active),
        m = s.masters.find((x) => x.id === masterId && x.active);
      if (!service || !m || !m.services.includes(serviceId))
        fail(400, "Выберите услугу и мастера");
      const windows = await this.windows(tx, s, masterId, date),
        busy = new Set(),
        slots = [];
      const refs = await Promise.all(
        Array.from({ length: 48 }, (_, i) =>
          tx.get(C.slots + "/" + slotKey({ masterId, date }, clock(i * 30))),
        ),
      );
      for (let i = 0; i < 48; i++) {
        const r = refs[i];
        if (r) {
          const b = await tx.get(C.bookings + "/" + r.bookingId);
          if (active(b, this.now())) busy.add(i * 30);
        }
      }
      for (const [a, b] of windows) {
        const end = b === "24:00" ? 1440 : minutes(b);
        for (let t = minutes(a); t < end; t += 30) {
          const startsAt = instant(date, clock(t), s.timezone);
          const occupied = busy.has(t);
          const fits = t + service.duration <= end;
          const overlap = Array.from(
            { length: service.duration / 30 },
            (_, i) => t + i * 30,
          ).some((x) => busy.has(x));
          const past = startsAt < this.now() + s.leadMinutes * 60000;
          const distant = startsAt > this.now() + s.horizonDays * 86400000;
          slots.push({
            time: clock(t),
            available: fits && !overlap && !past && !distant,
            reason: occupied
              ? "Занято"
              : !fits
                ? "Не хватает времени"
                : overlap
                  ? "Нет свободного интервала"
                  : past
                    ? "Прошло / слишком скоро"
                    : distant
                      ? "За пределами периода"
                      : "Свободно",
          });
        }
      }
      return { date, masterId, slots };
    });
  }
  async reserveSlots(tx, s, next, old = null, id) {
    const now = this.now(),
      nextTimes = active(next, now) ? slotTimes(next) : [],
      oldTimes = old && active(old, now) ? slotTimes(old) : [];
    if (nextTimes.length) {
      const windows = await this.windows(tx, s, next.masterId, next.date);
      const start = minutes(next.time);
      if (
        !windows.some(
          ([a, b]) =>
            start >= minutes(a) &&
            start + next.durationMinutes <= (b === "24:00" ? 1440 : minutes(b)),
        )
      )
        fail(409, "Мастер не работает в этот интервал");
    }
    const paths = new Set([
      ...nextTimes.map((t) => C.slots + "/" + slotKey(next, t)),
      ...oldTimes.map((t) => C.slots + "/" + slotKey(old, t)),
    ]);
    const existing = new Map();
    for (const p of paths) {
      const slot = await tx.get(p);
      existing.set(p, slot);
      if (slot && slot.bookingId !== id) {
        const b = await tx.get(C.bookings + "/" + slot.bookingId);
        if (
          nextTimes.some((t) => p === C.slots + "/" + slotKey(next, t)) &&
          active(b, now)
        )
          fail(409, "Время уже занято. Выберите другое окно");
      }
    }
    return () => {
      for (const t of oldTimes) {
        const p = C.slots + "/" + slotKey(old, t);
        if (
          existing.get(p)?.bookingId === id &&
          !nextTimes.some((n) => p === C.slots + "/" + slotKey(next, n))
        )
          tx.delete(p);
      }
      for (const t of nextTimes)
        tx.set(C.slots + "/" + slotKey(next, t), {
          bookingId: id,
          masterId: next.masterId,
          date: next.date,
          time: t,
        });
    };
  }
  async create(input, { user = null, ip = "local" } = {}) {
    const id = randomUUID(),
      token = randomBytes(24).toString("hex");
    const requestId = cleanText(input.requestId, 80, "Нужен ID запроса");
    if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) fail(400, "Неверный ID запроса");
    return this.store.transaction(async (tx) => {
      const s = await this.settings(tx),
        role = user ? await this.role(tx, user) : null;
      if (role) this.permit(role, ["owner", "manager", "receptionist"]);
      const data = bookingData(input, s, this.now(), !user);
      if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))
        fail(400, "Неверная почта");
      if (!user && !s.privacyApproved)
        fail(503, "Онлайн-запись готовится к запуску. Свяжитесь с салоном");
      const key = hash((user?.uid || ip) + "|" + requestId),
        prior = await tx.get(C.requests + "/" + key);
      // Exclude server-generated expiry when comparing repeat requests.
      const payloadHash = hash(JSON.stringify({ ...data, expiresAt: 0 }));
      if (prior) {
        if (prior.payloadHash !== payloadHash)
          fail(409, "ID уже использован для другого запроса");
        return { id: prior.bookingId, repeated: true };
      }
      const bucket =
        C.rates + "/" + hash(ip + "|" + Math.floor(this.now() / 86400000));
      const phoneBucket =
        C.rates +
        "/" +
        hash(data.phone + "|" + Math.floor(this.now() / 86400000));
      const rate = !user ? await tx.get(bucket) : null,
        phoneRate = !user ? await tx.get(phoneBucket) : null;
      if (!user && ((rate?.count || 0) >= 10 || (phoneRate?.count || 0) >= 5))
        fail(429, "Слишком много заявок. Свяжитесь с салоном");
      const apply = await this.reserveSlots(tx, s, data, null, id);
      const customerId = hash(data.phone),
        customer = await tx.get(C.customers + "/" + customerId);
      apply();
      tx.set(C.bookings + "/" + id, {
        ...data,
        id,
        createdAt: this.now(),
        updatedAt: this.now(),
        version: 1,
        cancelHash: hash(token),
        customerId,
        reminderKey:
          data.status === "confirmed" && data.email ? `reminder_${id}_1` : null,
      });
      tx.set(C.requests + "/" + key, {
        bookingId: id,
        payloadHash,
        createdAt: this.now(),
      });
      if (!user) {
        tx.set(bucket, {
          count: (rate?.count || 0) + 1,
          updatedAt: this.now(),
        });
        tx.set(phoneBucket, {
          count: (phoneRate?.count || 0) + 1,
          updatedAt: this.now(),
        });
      }
      tx.set(C.customers + "/" + customerId, {
        ...customer,
        name: data.name,
        phone: data.phone,
        notes: customer?.notes || "",
        updatedAt: this.now(),
      });
      this.audit(tx, user || { uid: "public" }, "create", id, {
        status: data.status,
      });
      tx.set(C.notifications + "/" + randomUUID(), {
        type: "new-booking",
        bookingId: id,
        status: "pending",
        createdAt: this.now(),
        dueAt: this.now(),
        attempts: 0,
      });
      if (data.status === "confirmed" && data.email)
        tx.set(C.notifications + `/reminder_${id}_1`, {
          type: "reminder",
          bookingId: id,
          status: "pending",
          startsAt: data.startsAt,
          dueAt: Math.max(
            this.now(),
            data.startsAt - s.reminderHours * 3600000,
          ),
          createdAt: this.now(),
          attempts: 0,
        });
      return {
        id,
        cancelToken: token,
        status: data.status,
        expiresAt: data.expiresAt,
      };
    });
  }
  safe(b) {
    const { cancelHash, ...rest } = b;
    return rest;
  }
  async list(user, { from, to, after = "" } = {}) {
    dateValid(from);
    dateValid(to);
    if (from > to || Date.parse(to) - Date.parse(from) > 93 * 86400000)
      fail(400, "Период не больше 93 дней");
    return this.store.transaction(async (tx) => {
      const role = await this.role(tx, user);
      const filters = [
        ["date", ">=", from],
        ["date", "<=", to],
      ];
      if (role.role === "master")
        filters.push(["masterId", "==", role.masterId]);
      const rows = await tx.query(C.bookings, filters, 101, after);
      return {
        items: rows.slice(0, 100).map((b) => ({
          ...this.safe(b),
          status:
            b.status === "new" && !active(b, this.now()) ? "expired" : b.status,
        })),
        next: rows.length > 100 ? rows[99].id : null,
      };
    });
  }
  async pending(user, after = "") {
    return this.store.transaction(async (tx) => {
      const role = await this.role(tx, user);
      const filters = [
        ["status", "==", "new"],
        ["expiresAt", ">=", this.now()],
      ];
      if (role.role === "master")
        filters.push(["masterId", "==", role.masterId]);
      const rows = await tx.query(C.bookings, filters, 101, after);
      return {
        items: rows.slice(0, 100).map((b) => this.safe(b)),
        next: rows.length > 100 ? rows[99].id : null,
      };
    });
  }
  async update(id, input, user) {
    return this.store.transaction(async (tx) => {
      const role = await this.role(tx, user),
        s = await this.settings(tx),
        old = await tx.get(C.bookings + "/" + id);
      if (!old) fail(404, "Запись не найдена");
      if (input.version !== old.version)
        fail(409, "Запись уже изменена. Обновите список");
      if (role.role === "master") {
        if (
          old.masterId !== role.masterId ||
          input.status !== "done" ||
          Object.keys(input).some((k) => !["status", "version"].includes(k))
        )
          fail(403, "Можно только завершить свои записи");
      } else this.permit(role, ["owner", "manager", "receptionist"]);
      const merged = { ...old, ...input };
      if (
        !["new", "confirmed", "done", "cancelled", "no-show"].includes(
          merged.status,
        )
      )
        fail(400, "Неверный статус");
      // Preserve booked duration/price for status-only updates after catalog changes.
      const appointmentChanged = ["serviceId", "masterId", "date", "time"].some(
        (k) => k in input && input[k] !== old[k],
      );
      const data = appointmentChanged
        ? bookingData(merged, s, this.now(), false)
        : {
            ...old,
            status: merged.status,
            name: cleanText(merged.name, 80, "Введите имя"),
            phone: phone(merged.phone),
            comment: String(merged.comment || "").slice(0, 300),
          };
      if (!appointmentChanged) {
        data.durationMinutes = old.durationMinutes;
        data.price = old.price;
        data.startsAt = old.startsAt;
      }
      if (
        ["new", "confirmed"].includes(data.status) &&
        data.startsAt < this.now()
      )
        fail(400, "Нельзя вернуть активную запись в прошлое");
      if (data.status === "new" && old.status === "new")
        data.expiresAt = old.expiresAt;
      else if (data.status === "new")
        data.expiresAt = this.now() + s.pendingHours * 3600000;
      const apply = await this.reserveSlots(tx, s, data, old, id);
      const customerId = hash(data.phone),
        customer = await tx.get(C.customers + "/" + customerId);
      apply();
      const b = {
        ...old,
        ...data,
        source: old.source,
        consentVersion: old.consentVersion,
        updatedAt: this.now(),
        version: old.version + 1,
        customerId,
      };
      if (
        b.status === "confirmed" &&
        b.email &&
        (old.status !== "confirmed" || appointmentChanged)
      )
        b.reminderKey = `reminder_${id}_${b.version}`;
      tx.set(C.bookings + "/" + id, b);
      tx.set(C.customers + "/" + customerId, {
        ...customer,
        name: b.name,
        phone: b.phone,
        notes: customer?.notes || "",
        updatedAt: this.now(),
      });
      this.audit(tx, user, "update", id, {
        before: {
          status: old.status,
          date: old.date,
          time: old.time,
          masterId: old.masterId,
        },
        after: {
          status: b.status,
          date: b.date,
          time: b.time,
          masterId: b.masterId,
        },
      });
      if (
        b.status === "confirmed" &&
        b.email &&
        (old.status !== "confirmed" || appointmentChanged)
      )
        tx.set(C.notifications + `/reminder_${id}_${b.version}`, {
          type: "reminder",
          bookingId: id,
          status: "pending",
          startsAt: b.startsAt,
          dueAt: Math.max(this.now(), b.startsAt - s.reminderHours * 3600000),
          createdAt: this.now(),
          attempts: 0,
        });
      return this.safe(b);
    });
  }
  async cancel(id, token) {
    return this.store.transaction(async (tx) => {
      const old = await tx.get(C.bookings + "/" + id);
      if (!old || typeof token !== "string" || old.cancelHash !== hash(token))
        fail(404, "Ссылка недействительна");
      if (!active(old, this.now()))
        fail(409, "Запись уже завершена, отменена или срок заявки истёк");
      if (old.startsAt <= this.now())
        fail(409, "Для отмены свяжитесь с салоном");
      const s = await this.settings(tx),
        next = { ...old, status: "cancelled" };
      const apply = await this.reserveSlots(tx, s, next, old, id);
      apply();
      tx.set(C.bookings + "/" + id, {
        ...next,
        updatedAt: this.now(),
        version: old.version + 1,
      });
      this.audit(tx, { uid: "client" }, "cancel", id);
      return { status: "cancelled" };
    });
  }
  async adminSettings(user) {
    return this.store.transaction(async (tx) => {
      const role = await this.role(tx, user);
      this.permit(role, ["owner", "manager", "receptionist", "master"]);
      return {
        settings: await this.settings(tx),
        role: role.role,
        notificationsEnabled: !!(
          process.env.RESEND_API_KEY &&
          process.env.MAIL_FROM &&
          process.env.ADMIN_NOTIFICATION_EMAIL
        ),
      };
    });
  }
  async saveSettings(user, input) {
    const next = validateSettings(input);
    return this.store.transaction(async (tx) => {
      const role = await this.role(tx, user);
      this.permit(role, ["owner", "manager"]);
      const old = await this.settings(tx);
      if (next.version !== old.version)
        fail(409, "Настройки уже изменены. Обновите страницу");
      if (next.timezone !== old.timezone) {
        const confirmed = await tx.query(
          C.bookings,
          [["status", "==", "confirmed"]],
          1,
        );
        const pending = await tx.query(
          C.bookings,
          [
            ["status", "==", "new"],
            ["expiresAt", ">=", this.now()],
          ],
          1,
        );
        if (confirmed.length || pending.length)
          fail(
            409,
            "Нельзя менять часовой пояс при активных записях. Сначала завершите или отмените их",
          );
      }
      next.version = old.version + 1;
      tx.set(C.settings + "/settings", next);
      this.audit(tx, user, "settings", "settings", { version: next.version });
      return next;
    });
  }
  async shift(user, { masterId, date, windows }) {
    dateValid(date);
    validateWindows(windows);
    return this.store.transaction(async (tx) => {
      const role = await this.role(tx, user);
      this.permit(role, ["owner", "manager"]);
      const s = await this.settings(tx);
      if (!s.masters.some((m) => m.id === masterId))
        fail(400, "Мастер не найден");
      const records = [];
      let after = "";
      for (;;) {
        const page = await tx.query(
          C.bookings,
          [
            ["date", "==", date],
            ["masterId", "==", masterId],
          ],
          100,
          after,
        );
        records.push(...page);
        if (page.length < 100) break;
        after = page.at(-1).id;
      }
      for (const b of records)
        if (
          active(b, this.now()) &&
          !windows.some(
            ([a, e]) =>
              minutes(b.time) >= minutes(a) &&
              minutes(b.time) + b.durationMinutes <=
                (e === "24:00" ? 1440 : minutes(e)),
          )
        )
          fail(
            409,
            "Вне смены есть активные записи. Сначала перенесите или отмените их",
          );
      tx.set(C.settings + `/shift_${masterId}_${date}`, {
        masterId,
        date,
        windows,
      });
      this.audit(tx, user, "shift", masterId, { date, windows });
      return { saved: true };
    });
  }
  async getShift(user, masterId, date) {
    dateValid(date);
    return this.store.transaction(async (tx) => {
      const role = await this.role(tx, user);
      this.permit(role, ["owner", "manager", "receptionist"]);
      return {
        windows: await this.windows(
          tx,
          await this.settings(tx),
          masterId,
          date,
        ),
      };
    });
  }
  async customers(user, after = "") {
    return this.store.transaction(async (tx) => {
      const role = await this.role(tx, user);
      this.permit(role, ["owner", "manager", "receptionist"]);
      const rows = await tx.query(C.customers, [], 101, after);
      return {
        items: rows.slice(0, 100),
        next: rows.length > 100 ? rows[99].id : null,
      };
    });
  }
  async customer(user, id, notes) {
    return this.store.transaction(async (tx) => {
      const role = await this.role(tx, user);
      this.permit(role, ["owner", "manager", "receptionist"]);
      const old = await tx.get(C.customers + "/" + id);
      if (!old) fail(404, "Клиент не найден");
      if (notes !== undefined) {
        if (typeof notes !== "string" || notes.length > 2000)
          fail(400, "Заметка не больше 2000 символов");
        tx.set(C.customers + "/" + id, {
          ...old,
          notes,
          updatedAt: this.now(),
        });
        this.audit(tx, user, "customer-note", id);
        return { saved: true };
      }
      const rows = await tx.query(C.bookings, [["customerId", "==", id]], 101);
      return {
        ...old,
        history: rows.slice(0, 100).map((b) => this.safe(b)),
        truncated: rows.length > 100,
      };
    });
  }
  async payment(user, id, input) {
    if (
      !Number.isInteger(input.amount) ||
      input.amount === 0 ||
      Math.abs(input.amount) > 10000000 ||
      !["cash", "card", "transfer"].includes(input.method)
    )
      fail(400, "Укажите сумму и способ оплаты");
    const requestId = cleanText(input.requestId, 80, "Нужен ID платежа");
    return this.store.transaction(async (tx) => {
      const role = await this.role(tx, user);
      this.permit(role, ["owner", "manager", "receptionist"]);
      const b = await tx.get(C.bookings + "/" + id);
      if (!b) fail(404, "Запись не найдена");
      const payments = b.payments || [],
        prior = payments.find((p) => p.id === requestId);
      if (prior) {
        if (prior.amount !== input.amount || prior.method !== input.method)
          fail(409, "ID платежа уже использован");
        return this.safe(b);
      }
      if (
        payments.length >= 50 ||
        payments.reduce((n, p) => n + p.amount, 0) + input.amount < 0
      )
        fail(400, "Проверьте сумму возврата");
      payments.push({
        id: requestId,
        amount: input.amount,
        method: input.method,
        actor: user.uid,
        createdAt: this.now(),
      });
      const next = {
        ...b,
        payments,
        version: b.version + 1,
        updatedAt: this.now(),
      };
      tx.set(C.bookings + "/" + id, next);
      this.audit(tx, user, "payment", id, {
        amount: input.amount,
        method: input.method,
      });
      return this.safe(next);
    });
  }
  async anonymize(user, id) {
    return this.store.transaction(async (tx) => {
      const role = await this.role(tx, user);
      this.permit(role, ["owner"]);
      const customer = await tx.get(C.customers + "/" + id);
      if (!customer) fail(404, "Клиент не найден");
      const records = await tx.query(
        C.bookings,
        [["customerId", "==", id]],
        401,
      );
      if (records.length > 400)
        fail(
          413,
          "Для большой истории нужен отдельный инструмент удаления данных",
        );
      if (records.some((b) => active(b, this.now())))
        fail(409, "Сначала завершите или отмените активные записи клиента");
      for (const b of records)
        tx.set(C.bookings + "/" + b.id, {
          ...b,
          name: "Клиент (данные удалены)",
          phone: "",
          email: "",
          comment: "",
          customerId: "removed",
          cancelHash: null,
          version: b.version + 1,
          updatedAt: this.now(),
        });
      tx.delete(C.customers + "/" + id);
      this.audit(tx, user, "anonymize-customer", id, {
        records: records.length,
      });
      return { anonymized: records.length };
    });
  }
  async members(user, input) {
    return this.store.transaction(async (tx) => {
      const role = await this.role(tx, user);
      this.permit(role, ["owner"]);
      if (!input) return { items: await tx.query(C.members, [], 100) };
      const uid = cleanText(
        input.uid,
        128,
        "Укажите UID из Firebase Authentication",
      );
      if (uid.includes("/")) fail(400, "Неверный UID");
      if (
        !["manager", "receptionist", "master"].includes(input.role) ||
        typeof input.active !== "boolean"
      )
        fail(400, "Неверная роль");
      const s = await this.settings(tx);
      if (
        input.role === "master" &&
        !s.masters.some((m) => m.id === input.masterId)
      )
        fail(400, "Укажите мастера");
      tx.set(C.members + "/" + uid, {
        role: input.role,
        masterId: input.role === "master" ? input.masterId : null,
        active: input.active,
      });
      this.audit(tx, user, "access", uid, {
        role: input.role,
        active: input.active,
      });
      return { saved: true };
    });
  }
  async auditLog(user, after = "") {
    return this.store.transaction(async (tx) => {
      const role = await this.role(tx, user);
      this.permit(role, ["owner", "manager"]);
      return { items: await tx.query(C.audit, [], 100, after) };
    });
  }
  async export(user) {
    return this.store.transaction(async (tx) => {
      const role = await this.role(tx, user);
      this.permit(role, ["owner"]);
      const result = {
        format: "salon-v2-backup",
        version: 1,
        createdAt: this.now(),
        collections: {},
      };
      for (const c of [
        C.settings,
        C.bookings,
        C.slots,
        C.members,
        C.audit,
        C.customers,
      ]) {
        let cursor = "";
        const rows = [];
        for (;;) {
          const page = await tx.query(c, [], 500, cursor);
          rows.push(...page);
          if (page.length < 500) break;
          cursor = page.at(-1).id;
          if (rows.length > 10000)
            fail(413, "Для большой базы используйте серверный экспорт");
        }
        result.collections[c] = rows;
      }
      return result;
    });
  }
}
module.exports = {
  Engine,
  Problem,
  C,
  active,
  slotTimes,
  validateSettings,
  instant,
  normalizePhone: phone,
  validateDate: dateValid,
};
