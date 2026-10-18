"use strict";
const { chromium } = require("playwright"),
  assert = require("node:assert/strict");
let server, tmp;
(async () => {
  let base = process.env.SALON_SYSTEM_URL;
  if (!base) {
    const fs = require("node:fs"),
      os = require("node:os"),
      path = require("node:path"),
      { spawn } = require("node:child_process");
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "salon-browser-"));
    server = spawn(
      process.execPath,
      [path.resolve(__dirname, "../backend/dev.cjs")],
      {
        env: {
          ...process.env,
          PORT: "0",
          SALON_LOCAL_DB: path.join(tmp, "test.sqlite"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    base = await new Promise((resolve, reject) => {
      let output = "";
      server.stdout.on("data", (d) => {
        output += d;
        const match = output.match(/ready on port (\d+)/);
        if (match) resolve("http://127.0.0.1:" + match[1]);
      });
      server.on("error", reject);
      server.on("exit", (code) =>
        reject(new Error("Test server stopped: " + code)),
      );
    });
  }
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROMIUM_PATH ||
      (require("node:fs").existsSync("/usr/bin/chromium")
        ? "/usr/bin/chromium"
        : undefined),
  });
  const errors = [];
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/next/admin.html");
    await page.locator("#dev-login").waitFor({ state: "visible" });
    await page.locator("#dev-login").click();
    await page.locator("#app").waitFor({ state: "visible" });
    await page.locator("[data-tab=settings]").click();
    await page
      .locator("#s-privacy")
      .fill("Тестовая локальная политика. Реальных клиентов в этой базе нет.");
    await page.locator("#s-approved").check();
    await page.locator("#s-durations").check();
    await page.locator("#settings-save").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        .textContent.includes("Настройки сохранены"),
    );
    const tomorrow = await page.locator("#to").inputValue();
    const client = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    client.on("pageerror", (e) => errors.push(e.message));
    await client.goto(base + "/next/index.html");
    await client
      .locator("#service option")
      .nth(1)
      .waitFor({ state: "attached" });
    assert.equal(
      await client.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await client.locator("#service").selectOption("service-3");
    await client.locator("#master").selectOption("master-1");
    await client.locator("#date").fill(tomorrow);
    await client
      .getByRole("button", { name: "16:00 · Свободно", exact: true })
      .click();
    await client.locator("#name").fill("Браузерный тест");
    await client.locator("#phone").fill("+77776543210");
    await client.locator("#consent").check();
    await client.locator("#submit").click();
    await client.locator("#success").waitFor({ state: "visible" });
    const cancelLink = await client
      .locator("#cancel-link")
      .getAttribute("href");
    assert(cancelLink.includes("#id="));
    await page.locator("[data-tab=bookings]").click();
    await page.locator("#refresh").click();
    await page
      .getByText("Браузерный тест", { exact: true })
      .waitFor({ state: "visible" });
    const card = page
      .locator("#bookings-list .card")
      .filter({ has: page.getByText("Браузерный тест", { exact: true }) });
    await card
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    await card
      .getByText("Подтверждена", { exact: true })
      .waitFor({ state: "visible" });
    await card.getByRole("button", { name: "Изменить", exact: true }).click();
    await page.locator("#e-time").fill("16:30");
    await page.locator("#editor-save").click();
    await page.locator("#editor").waitFor({ state: "hidden" });
    await card.getByRole("button", { name: "Оплата", exact: true }).click();
    await page.locator("#payment-amount").fill("6000");
    await page
      .locator(
        "#payment-form button[type=submit], #payment-form button:not([type])",
      )
      .first()
      .click();
    await page.locator("#payment-dialog").waitFor({ state: "hidden" });
    await card
      .getByText("Оплачено: 6 000 ₸", { exact: true })
      .waitFor({ state: "visible" });
    await page.locator("[data-tab=customers]").click();
    await page
      .getByRole("button", { name: "История и заметки" })
      .first()
      .click();
    await page.locator("#customer-notes").fill("Проверка сохранения заметки");
    await page.locator("#customer-save").click();
    await page.locator("#customer-dialog").waitFor({ state: "hidden" });
    await page.locator("[data-tab=shifts]").click();
    await page.locator("#shift-date").fill(tomorrow);
    await page.locator("#shift-windows").fill("");
    await page.locator("#shift-form button:not([type])").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        .textContent.includes("Сначала перенесите"),
    );
    await client.goto(cancelLink);
    await client.locator("#cancel").click();
    await client
      .getByText("Запись отменена. Спасибо, что сообщили.")
      .waitFor({ state: "visible" });
    await page.locator("#shift-form button:not([type])").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#message").textContent === "Смена сохранена",
    );
    await page.locator("[data-tab=bookings]").click();
    await page.locator("#refresh").click();
    await card
      .getByText("Отменена", { exact: true })
      .waitFor({ state: "visible" });
    await page.setViewportSize({ width: 320, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.locator("[data-tab=settings]").click();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.locator("[data-tab=backup]").click();
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#export").click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^salon-backup/);
    await page.locator("[data-tab=customers]").click();
    await page
      .getByRole("button", { name: "История и заметки" })
      .first()
      .click();
    await page.locator("#customer-dialog").waitFor({ state: "visible" });
    await page.evaluate(() => document.getElementById("logout").click());
    await page.locator("#login").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#customer-dialog").isVisible(),
      false,
      "logout must close personal-data dialogs",
    );
    assert.equal(await page.locator("#customer-phone").textContent(), "");
    await page.locator("#dev-login").click();
    await page.locator("#app").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#tab-bookings").isVisible(),
      true,
      "new session must start at bookings",
    );
    let releaseResponse, received;
    const release = new Promise((resolve) => {
        releaseResponse = resolve;
      }),
      captured = new Promise((resolve) => {
        received = resolve;
      });
    await page.route("**/api/v2/admin/customers", async (route) => {
      const response = await route.fetch();
      received();
      await release;
      await route.fulfill({ response });
    });
    await page.locator("[data-tab=customers]").click();
    await captured;
    await page.locator("#logout").click();
    releaseResponse();
    await page.waitForFunction(
      () =>
        document.getElementById("message").textContent === "Сессия завершена",
    );
    assert.equal(
      await page.locator("#customers-list").textContent(),
      "",
      "late responses must not restore client data after logout",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: full stack UI, 390/320px layout, logout clears private dialogs, resets tabs and rejects late client-data responses",
    );
  } finally {
    await browser.close();
  }
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
    }
    if (tmp) require("node:fs").rmSync(tmp, { recursive: true, force: true });
  });
