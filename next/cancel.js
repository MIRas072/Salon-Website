const values = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", location.pathname);
const b = document.getElementById("cancel"),
  m = document.getElementById("message");
if (!values.get("id") || !values.get("token")) {
  b.disabled = true;
  m.textContent =
    "Для отмены откройте сохранённую ссылку или свяжитесь с салоном.";
}
b.onclick = async () => {
  b.disabled = true;
  try {
    const r = await fetch(
      "/api/v2/cancel/" + encodeURIComponent(values.get("id")),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: values.get("token") }),
      },
    );
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    m.textContent = "Запись отменена. Спасибо, что сообщили.";
    b.hidden = true;
  } catch (e) {
    m.textContent = e.message;
    b.disabled = false;
  }
};
