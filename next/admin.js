"use strict";
const $ = (id) => document.getElementById(id),
  node = (tag, text, cls) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
let auth,
  localToken,
  settings,
  role,
  items = [],
  cursor = null,
  customerCursor = null,
  editing = null,
  currentCustomer = null,
  paymentBooking = null,
  paymentRequest = null,
  seen = new Set(),
  loaded = false,
  tab = "bookings",
  listSequence = 0;
let pendingView = false;
const statusName = {
  new: "Новая",
  confirmed: "Подтверждена",
  done: "Выполнена",
  cancelled: "Отменена",
  expired: "Срок истёк",
  "no-show": "Не пришёл",
};
function message(text, error = false) {
  $("message").textContent = text;
  $("message").className = error ? "error" : "success";
  $("message").hidden = false;
}
async function request(path, method = "GET", body) {
  const token = localToken || (await auth?.currentUser?.getIdToken());
  const r = await fetch("/api/v2/admin/" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Ошибка сервера");
  return data;
}
function button(text, action, cls = "secondary") {
  const b = node("button", text, cls);
  b.type = "button";
  b.onclick = async () => {
    b.disabled = true;
    try {
      await action();
    } catch (e) {
      message(e.message, true);
    } finally {
      b.disabled = false;
    }
  };
  return b;
}
function select(el, rows, empty) {
  el.replaceChildren();
  if (empty !== undefined) {
    const o = node("option", empty);
    o.value = "";
    el.append(o);
  }
  for (const row of rows) {
    const o = node("option", row.name);
    o.value = row.id;
    el.append(o);
  }
}
function day() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: settings.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
function plus(d, n) {
  const t = new Date(d + "T12:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
async function enter() {
  try {
    const data = await request("settings");
    settings = data.settings;
    role = data.role;
    $("identity").textContent =
      settings.name +
      " · " +
      {
        owner: "Владелец",
        manager: "Управляющий",
        receptionist: "Администратор",
        master: "Мастер",
      }[role];
    $("login").hidden = true;
    $("app").hidden = false;
    $("logout").hidden = false;
    $("from").value = day();
    $("to").value = plus(day(), 14);
    $("shift-date").value = day();
    for (const id of ["filter-master", "shift-master", "member-master"])
      select(
        $(id),
        settings.masters,
        id === "filter-master" ? "Все" : undefined,
      );
    for (const b of document.querySelectorAll("[data-tab]"))
      b.hidden =
        role === "master"
          ? b.dataset.tab !== "bookings"
          : b.dataset.tab === "members" || b.dataset.tab === "backup"
            ? role !== "owner"
            : ["settings", "audit"].includes(b.dataset.tab)
              ? !["owner", "manager"].includes(role)
              : false;
    $("add").hidden = role === "master";
    $("shift-form").querySelector("button:last-child").hidden = ![
      "owner",
      "manager",
    ].includes(role);
    renderSettings();
    await loadBookings();
    if (!data.notificationsEnabled)
      message(
        "Автоматические письма не подключены. Проверяйте новые заявки в кабинете и связывайтесь через WhatsApp.",
      );
    if (!settings.durationsApproved)
      message(
        "Проверьте длительности услуг с мастерами в настройках перед запуском.",
      );
  } catch (e) {
    message(e.message, true);
  }
}
async function loadBookings(more = false) {
  const seq = ++listSequence,
    q = new URLSearchParams({ from: $("from").value, to: $("to").value });
  if (more && cursor) q.set("after", cursor);
  const data = await request(
    pendingView
      ? "pending" +
          (more && cursor ? "?after=" + encodeURIComponent(cursor) : "")
      : "bookings?" + q,
  );
  if (seq !== listSequence) return;
  const fresh = data.items.filter(
    (b) => b.source === "site" && b.status === "new" && !seen.has(b.id),
  );
  if (loaded && fresh.length) {
    $("new-notice").hidden = false;
    $("new-notice").textContent =
      "Новые заявки: " + fresh.length + ". Откройте фильтр «Новые».";
  }
  for (const b of data.items) seen.add(b.id);
  loaded = true;
  items = more ? items.concat(data.items) : data.items;
  cursor = data.next;
  $("more").hidden = !cursor;
  renderBookings();
}
function renderBookings() {
  const q = $("search").value.toLowerCase(),
    digits = q.replace(/\D/g, "");
  const filtered = items.filter(
    (b) =>
      (!$("filter-master").value || b.masterId === $("filter-master").value) &&
      (!$("filter-status").value || b.status === $("filter-status").value) &&
      (!q ||
        b.name.toLowerCase().includes(q) ||
        (digits.length > 2 && b.phone.includes(digits))),
  );
  $("bookings-list").replaceChildren();
  filtered.sort((a, b) =>
    (a.date + " " + a.time).localeCompare(b.date + " " + b.time),
  );
  for (const b of filtered) {
    const c = node("article", undefined, "card overflow-text"),
      top = node("div", undefined, "row spread");
    top.append(
      node("h3", b.date + " · " + b.time),
      node("span", statusName[b.status] || b.status, "badge"),
    );
    c.append(
      top,
      node("p", b.name),
      node("p", b.service + " · " + b.masterName),
      node("p", b.durationMinutes + " мин · от " + b.price + " ₸"),
    );
    if (b.comment) c.append(node("p", b.comment));
    const tel = node("a", b.phone);
    tel.href = "tel:" + b.phone;
    c.append(tel);
    const actions = node("div", undefined, "row");
    if (role === "master") {
      if (b.status === "confirmed")
        actions.append(
          button("Выполнено", async () => {
            await request("bookings/" + b.id, "PATCH", {
              status: "done",
              version: b.version,
            });
            await loadBookings();
          }),
        );
    } else {
      actions.append(button("Изменить", () => openEditor(b)));
      if (b.status === "new")
        actions.append(button("Подтвердить", () => setStatus(b, "confirmed")));
      if (["new", "confirmed"].includes(b.status))
        actions.append(
          button("Отменить", () => setStatus(b, "cancelled"), "danger"),
        );
      if (b.status === "confirmed")
        actions.append(button("Выполнено", () => setStatus(b, "done")));
      const wa = node("a", "WhatsApp", "button secondary");
      wa.href =
        "https://wa.me/" +
        b.phone.replace(/\D/g, "") +
        "?text=" +
        encodeURIComponent(
          "Здравствуйте, " +
            b.name +
            "! Это " +
            settings.name +
            ". Ваша запись: " +
            b.service +
            ", " +
            b.date +
            " в " +
            b.time +
            ". Статус: " +
            statusName[b.status] +
            ". Адрес: " +
            settings.address,
        );
      wa.target = "_blank";
      wa.rel = "noopener noreferrer";
      actions.append(
        wa,
        button("Оплата", () => {
          paymentBooking = b;
          paymentRequest = crypto.randomUUID();
          $("payment-amount").value = "";
          $("payment-error").hidden = true;
          $("payment-dialog").showModal();
        }),
      );
    }
    const paid = (b.payments || []).reduce((sum, p) => sum + p.amount, 0);
    c.append(
      node("p", "Оплачено: " + paid.toLocaleString("ru-RU") + " ₸"),
      actions,
    );
    $("bookings-list").append(c);
  }
  if (!filtered.length)
    $("bookings-list").append(
      node("p", "В этом периоде записей по выбранным фильтрам нет."),
    );
  const newCount = items.filter((b) => b.status === "new").length,
    revenue = items.reduce(
      (sum, b) => sum + (b.payments || []).reduce((n, p) => n + p.amount, 0),
      0,
    );
  $("stats").replaceChildren();
  for (const [label, value] of [
    ["Загружено записей", items.length],
    ["Ожидают подтверждения", newCount],
    ["Оплаты − возвраты, ₸", revenue],
  ]) {
    const box = node("div", undefined, "card");
    box.append(node("p", label), node("b", String(value), "stat"));
    $("stats").append(box);
  }
}
async function setStatus(b, status) {
  if (status === "cancelled" && !confirm("Отменить запись клиента?")) return;
  await request("bookings/" + b.id, "PATCH", { status, version: b.version });
  await loadBookings();
  message("Запись обновлена");
}
function editorMasters() {
  const prev = $("e-master").value;
  select(
    $("e-master"),
    settings.masters.filter(
      (m) => m.active && m.services.includes($("e-service").value),
    ),
  );
  if (Array.from($("e-master").options).some((o) => o.value === prev))
    $("e-master").value = prev;
}
function openEditor(b) {
  editing = b;
  $("editor-title").textContent = b ? "Изменить запись" : "Новая запись";
  $("editor-error").hidden = true;
  select(
    $("e-service"),
    settings.services.filter((s) => s.active),
  );
  $("e-service").value =
    b?.serviceId || settings.services.find((s) => s.active)?.id || "";
  editorMasters();
  if (b) $("e-master").value = b.masterId;
  $("e-name").value = b?.name || "";
  $("e-phone").value = b?.phone || "";
  $("e-date").value = b?.date || day();
  $("e-time").value = b?.time || "10:00";
  $("e-comment").value = b?.comment || "";
  $("e-status").value =
    b?.status === "expired" ? "cancelled" : b?.status || "confirmed";
  $("editor").showModal();
}
$("e-service").onchange = editorMasters;
$("editor-close").onclick = () => $("editor").close();
$("editor-form").onsubmit = async (e) => {
  e.preventDefault();
  $("editor-save").disabled = true;
  try {
    const data = {
      name: $("e-name").value,
      phone: $("e-phone").value,
      serviceId: $("e-service").value,
      masterId: $("e-master").value,
      date: $("e-date").value,
      time: $("e-time").value,
      status: $("e-status").value,
      comment: $("e-comment").value,
    };
    await request(
      "bookings" + (editing ? "/" + editing.id : ""),
      editing ? "PATCH" : "POST",
      editing
        ? { ...data, version: editing.version }
        : { ...data, requestId: crypto.randomUUID() },
    );
    $("editor").close();
    await loadBookings();
    message("Запись сохранена");
  } catch (e) {
    $("editor-error").hidden = false;
    $("editor-error").textContent = e.message;
  } finally {
    $("editor-save").disabled = false;
  }
};
function field(value, type = "text") {
  const e = node("input");
  e.type = type;
  if (type === "checkbox") e.checked = value;
  else e.value = value;
  return e;
}
function labelled(text, input) {
  const box = node("div"),
    label = node("label", text);
  label.append(input);
  box.append(label);
  return box;
}
function renderSettings() {
  for (const [id, key] of [
    ["s-name", "name"],
    ["s-address", "address"],
    ["s-phone", "phone"],
    ["s-timezone", "timezone"],
    ["s-pending", "pendingHours"],
    ["s-horizon", "horizonDays"],
    ["s-lead", "leadMinutes"],
    ["s-privacy-version", "privacyVersion"],
    ["s-privacy", "privacyText"],
  ])
    $(id).value = settings[key];
  $("s-approved").checked = settings.privacyApproved;
  $("s-durations").checked = settings.durationsApproved;
  $("services-editor").replaceChildren();
  for (const s of settings.services) {
    const row = node("div", undefined, "catalog-row");
    row.dataset.id = s.id;
    const name = field(s.name),
      price = field(s.price, "number"),
      duration = field(s.duration, "number"),
      enabled = field(s.active, "checkbox");
    name.dataset.key = "name";
    price.dataset.key = "price";
    duration.dataset.key = "duration";
    enabled.dataset.key = "active";
    price.min = 0;
    duration.min = 30;
    duration.max = 480;
    duration.step = 30;
    row.append(
      labelled("Услуга", name),
      labelled("Цена от, ₸", price),
      labelled("Минут", duration),
      labelled("Активна", enabled),
    );
    $("services-editor").append(row);
  }
  $("masters-editor").replaceChildren();
  $("weekly-editor").replaceChildren();
  for (const m of settings.masters) {
    const row = node("div", undefined, "catalog-row master-row");
    row.dataset.id = m.id;
    const name = field(m.name),
      enabled = field(m.active, "checkbox");
    name.dataset.key = "name";
    enabled.dataset.key = "active";
    const checks = node("div", undefined, "checklist");
    for (const s of settings.services) {
      const l = node("label"),
        c = field(m.services.includes(s.id), "checkbox");
      c.dataset.service = s.id;
      l.append(c, document.createTextNode(s.name));
      checks.append(l);
    }
    row.append(labelled("Мастер", name), checks, labelled("Активен", enabled));
    $("masters-editor").append(row);
    const weekly = node("section", undefined, "panel");
    weekly.dataset.id = m.id;
    weekly.append(node("h3", m.name));
    for (let d = 0; d < 7; d++) {
      const input = field(
        (settings.weekly[m.id]?.[d] || []).map((w) => w.join("-")).join(", "),
      );
      input.dataset.day = d;
      weekly.append(
        labelled(["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][d], input),
      );
    }
    $("weekly-editor").append(weekly);
  }
}
function parseWindows(value) {
  return value.trim()
    ? value
        .trim()
        .split(/[,\n]+/)
        .filter((x) => x.trim())
        .map((x) =>
          x
            .trim()
            .split("-")
            .map((y) => y.trim()),
        )
    : [];
}
function collectSettings() {
  const s = structuredClone(settings);
  for (const [id, key] of [
    ["s-name", "name"],
    ["s-address", "address"],
    ["s-phone", "phone"],
    ["s-timezone", "timezone"],
    ["s-privacy-version", "privacyVersion"],
    ["s-privacy", "privacyText"],
  ])
    s[key] = $(id).value;
  for (const [id, key] of [
    ["s-pending", "pendingHours"],
    ["s-horizon", "horizonDays"],
    ["s-lead", "leadMinutes"],
  ])
    s[key] = Number($(id).value);
  s.privacyApproved = $("s-approved").checked;
  s.durationsApproved = $("s-durations").checked;
  s.services = Array.from($("services-editor").children).map((row) => ({
    id: row.dataset.id,
    name: row.querySelector("[data-key=name]").value,
    price: Number(row.querySelector("[data-key=price]").value),
    duration: Number(row.querySelector("[data-key=duration]").value),
    active: row.querySelector("[data-key=active]").checked,
  }));
  s.masters = Array.from($("masters-editor").children).map((row) => ({
    id: row.dataset.id,
    name: row.querySelector("[data-key=name]").value,
    active: row.querySelector("[data-key=active]").checked,
    services: Array.from(row.querySelectorAll("[data-service]:checked")).map(
      (e) => e.dataset.service,
    ),
  }));
  s.weekly = {};
  for (const row of $("weekly-editor").children)
    s.weekly[row.dataset.id] = Object.fromEntries(
      Array.from(row.querySelectorAll("[data-day]")).map((e) => [
        e.dataset.day,
        parseWindows(e.value),
      ]),
    );
  return s;
}
$("service-add").onclick = () => {
  settings = collectSettings();
  settings.services.push({
    id: "service-" + crypto.randomUUID(),
    name: "Новая услуга",
    price: 0,
    duration: 30,
    active: true,
  });
  renderSettings();
};
$("master-add").onclick = () => {
  settings = collectSettings();
  const id = "master-" + crypto.randomUUID();
  settings.masters.push({
    id,
    name: "Новый мастер",
    services: [],
    active: true,
  });
  settings.weekly[id] = Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => [i, []]),
  );
  renderSettings();
};
$("settings-form").onsubmit = async (e) => {
  e.preventDefault();
  $("settings-save").disabled = true;
  try {
    settings = await request("settings", "PUT", collectSettings());
    renderSettings();
    message("Настройки сохранены. Они применяются к новым записям.");
  } catch (e) {
    message(e.message, true);
  } finally {
    $("settings-save").disabled = false;
  }
};
async function loadShift() {
  const q = new URLSearchParams({
    date: $("shift-date").value,
    masterId: $("shift-master").value,
  });
  const r = await request("shifts?" + q);
  $("shift-windows").value = r.windows.map((w) => w.join("-")).join("\n");
}
$("shift-load").onclick = () =>
  loadShift().catch((e) => message(e.message, true));
$("shift-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await request("shifts", "PUT", {
      date: $("shift-date").value,
      masterId: $("shift-master").value,
      windows: parseWindows($("shift-windows").value),
    });
    message("Смена сохранена");
  } catch (e) {
    message(e.message, true);
  }
};
async function loadCustomers(more = false) {
  const r = await request(
    "customers" +
      (more && customerCursor
        ? "?after=" + encodeURIComponent(customerCursor)
        : ""),
  );
  if (!more) $("customers-list").replaceChildren();
  for (const c of r.items) {
    const box = node("article", undefined, "card");
    box.append(
      node("h3", c.name),
      node("p", c.phone),
      button("История и заметки", () => openCustomer(c)),
    );
    $("customers-list").append(box);
  }
  customerCursor = r.next;
  $("customers-more").hidden = !customerCursor;
}
async function openCustomer(c) {
  const r = await request("customers/" + c.id);
  currentCustomer = c.id;
  $("customer-remove").hidden = role !== "owner";
  $("customer-title").textContent = r.name;
  $("customer-phone").textContent = r.phone;
  $("customer-notes").value = r.notes || "";
  $("customer-history").replaceChildren();
  for (const b of r.history)
    $("customer-history").append(
      node(
        "p",
        `${b.date} ${b.time} · ${b.service} · ${statusName[b.status] || b.status}`,
      ),
    );
  if (r.truncated)
    $("customer-history").append(
      node(
        "p",
        "Показаны первые 100 визитов; полный архив доступен в экспорте.",
      ),
    );
  $("customer-dialog").showModal();
}
$("customer-close").onclick = () => $("customer-dialog").close();
$("customer-remove").onclick = async () => {
  if (
    !confirm(
      "Удалить имя, телефон, почту и заметки из истории клиента? Отменить это действие нельзя. Сохранённые ранее копии требуют отдельной обработки.",
    )
  )
    return;
  try {
    await request("customers/" + currentCustomer, "DELETE");
    $("customer-dialog").close();
    await loadCustomers();
    message(
      "Личные данные удалены из действующей V2-базы. Проверьте сохранённые копии и старый архив.",
    );
  } catch (e) {
    message(e.message, true);
  }
};
$("customer-save").onclick = async () => {
  try {
    await request("customers/" + currentCustomer, "PATCH", {
      notes: $("customer-notes").value,
    });
    message("Заметки сохранены");
    $("customer-dialog").close();
  } catch (e) {
    message(e.message, true);
  }
};
$("customers-more").onclick = () =>
  loadCustomers(true).catch((e) => message(e.message, true));
$("payment-close").onclick = () => $("payment-dialog").close();
$("payment-form").onsubmit = async (e) => {
  e.preventDefault();
  const b = e.submitter;
  b.disabled = true;
  try {
    await request("payments/" + paymentBooking.id, "POST", {
      requestId: paymentRequest,
      amount: Number($("payment-amount").value),
      method: $("payment-method").value,
    });
    $("payment-dialog").close();
    await loadBookings();
    message("Оплата записана");
  } catch (e) {
    $("payment-error").hidden = false;
    $("payment-error").textContent = e.message;
  } finally {
    b.disabled = false;
  }
};
async function loadMembers() {
  const r = await request("members");
  $("members-list").replaceChildren();
  for (const m of r.items) {
    const row = node(
      "p",
      m.id + " · " + m.role + " · " + (m.active ? "Включён" : "Отключён"),
    );
    row.append(
      button("Изменить", () => {
        $("member-uid").value = m.id;
        $("member-role").value = m.role;
        $("member-active").checked = m.active;
        $("member-master").value = m.masterId || "";
      }),
    );
    $("members-list").append(row);
  }
}
$("member-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await request("members", "PUT", {
      uid: $("member-uid").value,
      role: $("member-role").value,
      masterId: $("member-master").value,
      active: $("member-active").checked,
    });
    await loadMembers();
    message("Доступ обновлён");
  } catch (e) {
    message(e.message, true);
  }
};
function saveBlob(data, name) {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    ),
    a = node("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
$("export").onclick = async () => {
  try {
    saveBlob(await request("export"), "salon-backup-" + day() + ".json");
    message("Резервная копия скачана");
  } catch (e) {
    message(e.message, true);
  }
};
for (const b of document.querySelectorAll("[data-tab]"))
  b.onclick = async () => {
    tab = b.dataset.tab;
    for (const x of document.querySelectorAll("[data-tab]"))
      x.classList.toggle("active", x === b);
    for (const id of [
      "bookings",
      "shifts",
      "customers",
      "settings",
      "members",
      "audit",
      "backup",
    ])
      $("tab-" + id).hidden = id !== tab;
    try {
      if (tab === "customers") await loadCustomers();
      if (tab === "members") await loadMembers();
      if (tab === "audit") {
        const r = await request("audit");
        $("audit-list").textContent = r.items
          .map(
            (x) =>
              new Date(x.createdAt).toLocaleString("ru-RU", {
                timeZone: settings.timezone,
              }) +
              " · " +
              x.actor +
              " · " +
              x.action +
              " · " +
              x.recordId,
          )
          .join("\n");
      }
    } catch (e) {
      message(e.message, true);
    }
  };
$("add").onclick = () => openEditor();
$("refresh").onclick = () =>
  loadBookings().catch((e) => message(e.message, true));
$("more").onclick = () =>
  loadBookings(true).catch((e) => message(e.message, true));
$("all-new").onclick = () => {
  pendingView = true;
  $("filter-status").value = "new";
  loadBookings().catch((e) => message(e.message, true));
};
for (const id of ["filter-master", "filter-status", "search"])
  $(id).oninput = renderBookings;
for (const id of ["from", "to"])
  $(id).onchange = () => {
    pendingView = false;
    loadBookings().catch((e) => message(e.message, true));
  };
function load(src) {
  return new Promise((resolve, reject) => {
    const s = node("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Не удалось загрузить службу входа"));
    document.head.append(s);
  });
}
async function firebase() {
  if (auth) return;
  for (const name of ["app", "auth"])
    await load(
      "https://www.gstatic.com/firebasejs/10.14.1/firebase-" +
        name +
        "-compat.js",
    );
  if (!window.firebase.apps.length)
    window.firebase.initializeApp(window.SALON_FIREBASE);
  auth = window.firebase.auth();
  auth.onAuthStateChanged((user) => {
    if (user) enter();
  });
}
$("login-form").onsubmit = async (e) => {
  e.preventDefault();
  e.submitter.disabled = true;
  try {
    await firebase();
    await auth.signInWithEmailAndPassword(
      $("email").value,
      $("password").value,
    );
    $("password").value = "";
  } catch {
    message("Не удалось войти. Проверьте почту, пароль и соединение.", true);
  } finally {
    e.submitter.disabled = false;
  }
};
$("reset").onclick = async () => {
  if (!$("email").value) {
    message("Введите почту для восстановления.", true);
    return;
  }
  try {
    await firebase();
    await auth.sendPasswordResetEmail($("email").value);
    message("Если аккаунт существует, инструкция придёт на указанную почту.");
  } catch {
    message("Не удалось отправить инструкцию. Повторите позже.", true);
  }
};
$("logout").onclick = async () => {
  if (auth) await auth.signOut();
  localToken = null;
  items = [];
  seen = new Set();
  loaded = false;
  listSequence++;
  $("app").hidden = true;
  $("login").hidden = false;
  $("logout").hidden = true;
  $("bookings-list").replaceChildren();
  $("customers-list").replaceChildren();
};
if (["localhost", "127.0.0.1"].includes(location.hostname)) {
  fetch("/api/v2/dev-session")
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (s?.development) {
        $("dev-login").hidden = false;
        $("dev-login").onclick = () => {
          localToken = s.token;
          enter();
        };
      }
    })
    .catch(() => {});
} else firebase().catch((e) => message(e.message, true));
setInterval(() => {
  if (!document.hidden && !$("app").hidden && tab === "bookings")
    loadBookings().catch((e) => message(e.message, true));
}, 60000);
