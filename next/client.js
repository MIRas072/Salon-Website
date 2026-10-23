"use strict";
const $ = (id) => document.getElementById(id);
let catalog,
  chosen = "",
  sequence = 0,
  ready = false,
  sending = false,
  requestId = crypto.randomUUID();
async function api(path, body) {
  const r = await fetch("/api/v2/" + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Нет связи с салоном");
  return data;
}
const show = (id, text) => {
  $(id).textContent = text;
  $(id).hidden = false;
};
function option(value, text) {
  const n = document.createElement("option");
  n.value = value;
  n.textContent = text;
  return n;
}
function arrowIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("arrow-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3 13 13 3M3 3h10v10");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.2");
  path.setAttribute("fill", "none");
  svg.append(path);
  return svg;
}
function today() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: catalog.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
function renderCatalog() {
  for (const [index, s] of catalog.services.entries()) {
    const card = document.createElement("article");
    card.className = "card";
    const title = document.createElement("h3");
    title.textContent = s.name;
    const detail = document.createElement("p");
    detail.className = "service-price";
    detail.textContent = `от ${s.price.toLocaleString("ru-RU")} ₸ · ${s.duration} мин`;
    const masters = document.createElement("p");
    masters.className = "service-masters";
    masters.textContent = catalog.masters
      .filter((m) => m.services.includes(s.id))
      .map((m) => m.name)
      .join(", ");
    const b = document.createElement("button");
    b.append(arrowIcon());
    b.setAttribute("aria-label", "Выбрать: " + s.name);
    b.className = "secondary";
    b.onclick = () => {
      $("service").value = s.id;
      fillMasters();
      $("booking").scrollIntoView({ behavior: "smooth" });
    };
    const number = document.createElement("span");
    number.className = "service-number";
    number.textContent = String(index + 1).padStart(2, "0");
    card.append(number, title, detail, masters, b);
    $("catalog").append(card);
    $("service").append(option(s.id, `${s.name} · ${s.duration} мин`));
  }
  const team = $("team");
  if (team) {
    team.replaceChildren();
    for (const m of catalog.masters) {
      const card = document.createElement("article");
      card.className = "team-card";
      const mark = document.createElement("div");
      mark.className = "team-monogram";
      mark.textContent = m.name.charAt(0);
      mark.setAttribute("aria-hidden", "true");
      const name = document.createElement("h3");
      name.textContent = m.name;
      const description = document.createElement("p");
      description.textContent =
        m.services.length === catalog.services.length
          ? "Все направления салона"
          : catalog.services
              .filter((s) => m.services.includes(s.id))
              .slice(0, 3)
              .map((s) => s.name)
              .join(" · ") + (m.services.length > 3 ? " и другие услуги" : "");
      const choose = document.createElement("button");
      choose.type = "button";
      choose.textContent = "Выбрать мастера";
      choose.append(arrowIcon());
      choose.onclick = () => {
        if ($("service").value && !m.services.includes($("service").value))
          $("service").value = "";
        if (!$("service").value) {
          $("master").replaceChildren(option("", "Выберите мастера"));
          catalog.masters.forEach((master) =>
            $("master").append(option(master.id, master.name)),
          );
        }
        $("master").value = m.id;
        chosen = "";
        refresh();
        $("booking").scrollIntoView({ behavior: "smooth" });
      };
      card.append(mark, name, description, choose);
      team.append(card);
    }
  }
}
function fillMasters() {
  const previous = $("master").value;
  $("master").replaceChildren(option("", "Выберите мастера"));
  catalog.masters
    .filter((m) => m.services.includes($("service").value))
    .forEach((m) => $("master").append(option(m.id, m.name)));
  if (Array.from($("master").options).some((o) => o.value === previous))
    $("master").value = previous;
  chosen = "";
  refresh();
}
function canSend() {
  $("submit").disabled =
    sending || !ready || !chosen || !catalog?.privacyApproved;
}
async function refresh() {
  const version = ++sequence;
  ready = false;
  canSend();
  if (!$("service").value || !$("master").value || !$("date").value) {
    $("slots").replaceChildren();
    $("availability").textContent = "Выберите услугу, мастера и дату.";
    return;
  }
  $("availability").textContent = "Проверяем расписание…";
  try {
    const q = new URLSearchParams({
      masterId: $("master").value,
      serviceId: $("service").value,
      date: $("date").value,
    });
    const result = await api("availability?" + q);
    if (version !== sequence) return;
    ready = true;
    if (chosen && !result.slots.some((s) => s.time === chosen && s.available)) {
      chosen = "";
      show("form-error", "Выбранное время недоступно. Выберите другое окно.");
    }
    $("slots").replaceChildren();
    for (const s of result.slots) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = s.time + " · " + s.reason;
      b.disabled = !s.available || sending;
      b.className = s.time === chosen ? "selected" : "";
      b.setAttribute("aria-pressed", String(s.time === chosen));
      b.onclick = () => {
        chosen = s.time;
        $("time").value = chosen;
        $("form-error").hidden = true;
        refresh();
      };
      $("slots").append(b);
    }
    $("availability").textContent = result.slots.some((s) => s.available)
      ? "Выберите свободный интервал. Занятые окна выбрать нельзя."
      : "Свободного времени нет. Выберите другую дату или мастера.";
    canSend();
  } catch (e) {
    if (version !== sequence) return;
    $("slots").replaceChildren();
    show("availability", e.message + " Можно связаться с салоном по телефону.");
    canSend();
  }
}
$("service").onchange = fillMasters;
$("master").onchange = $("date").onchange = () => {
  chosen = "";
  refresh();
};
$("booking-form").onsubmit = async (e) => {
  e.preventDefault();
  if (sending || !chosen || !ready) return;
  sending = true;
  canSend();
  $("form-error").hidden = true;
  try {
    const result = await api("bookings", {
      requestId,
      name: $("name").value,
      phone: $("phone").value,
      email: $("client-email").value,
      serviceId: $("service").value,
      masterId: $("master").value,
      date: $("date").value,
      time: chosen,
      comment: $("comment").value,
      consent: $("consent").checked,
      challengeToken: window.turnstile?.getResponse(),
    });
    $("booking-form").hidden = true;
    $("success").hidden = false;
    $("success-text").textContent =
      "Ждём подтверждения администратора. " +
      (result.expiresAt
        ? "Если заявку не подтвердят до " +
          new Date(result.expiresAt).toLocaleString("ru-RU", {
            timeZone: catalog.timezone,
          }) +
          ", время освободится."
        : "Повторный запрос обработан; обратитесь к салону для подтверждения.");
    if (result.cancelToken) {
      const url = new URL("cancel.html", location.href);
      url.hash = new URLSearchParams({
        id: result.id,
        token: result.cancelToken,
      }).toString();
      $("cancel-link").href = url.href;
    } else $("cancel-link").hidden = true;
  } catch (e) {
    show("form-error", e.message);
    sending = false;
    await refresh();
    if (window.turnstile) window.turnstile.reset();
  } finally {
    sending = false;
    canSend();
  }
};
api("catalog")
  .then((s) => {
    catalog = s;
    document.title = s.name + " · Онлайн-запись";
    $("brand").textContent = s.name;
    $("address").textContent = $("contact-address").textContent = s.address;
    $("call").href = "tel:" + s.phone;
    $("call").textContent = s.phone;
    $("whatsapp").href = "https://wa.me/" + s.phone.replace(/\D/g, "");
    $("date").min = today();
    const max = new Date(today() + "T12:00:00Z");
    max.setUTCDate(max.getUTCDate() + s.horizonDays);
    $("date").max = max.toISOString().slice(0, 10);
    renderCatalog();
    if (!s.privacyApproved)
      show(
        "launch-warning",
        "Онлайн-запись пока закрыта: владелец должен утвердить политику обработки данных.",
      );
    if (s.turnstileSiteKey) {
      const script = document.createElement("script");
      script.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.onload = () =>
        window.turnstile.render("#challenge", {
          sitekey: s.turnstileSiteKey,
          action: "booking",
        });
      document.head.append(script);
    }
  })
  .catch((e) => show("load-error", e.message));
setInterval(() => {
  if (
    !document.hidden &&
    !sending &&
    catalog &&
    $("booking-form").hidden === false
  )
    refresh();
}, 60000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && catalog) refresh();
});
