fetch("/api/v2/catalog")
  .then(async (r) => {
    if (!r.ok) throw new Error("Документ временно недоступен");
    return r.json();
  })
  .then((s) => {
    document.getElementById("state").textContent = s.privacyApproved
      ? "Версия: " + s.privacyVersion
      : "Это проект документа. Онлайн-запись до утверждения закрыта.";
    document.getElementById("policy").textContent = s.privacyText;
  })
  .catch((e) => (document.getElementById("state").textContent = e.message));
