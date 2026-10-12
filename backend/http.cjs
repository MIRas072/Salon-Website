"use strict";
const { Problem } = require("./engine.cjs");
const safeId = (id) => {
  if (!/^[\w-]{1,128}$/.test(id || ""))
    throw new Problem(400, "Неверный идентификатор");
  return id;
};
function handler(
  engine,
  authenticate,
  { verifyChallenge = async () => {}, development = false } = {},
) {
  return async ({
    method,
    path,
    query = {},
    body = {},
    headers = {},
    ip = "unknown",
  }) => {
    const common = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    try {
      const prefix = path.indexOf("/api/v2/");
      const segments = (prefix >= 0 ? path.slice(prefix + 8) : path)
        .split("/")
        .filter(Boolean);
      let result;
      const route = segments[0];
      if (method === "GET" && route === "health")
        result = { ok: true, version: 2 };
      else if (method === "GET" && route === "catalog")
        result = await engine.catalog();
      else if (method === "GET" && route === "availability")
        result = await engine.availability(
          query.masterId,
          query.date,
          query.serviceId,
        );
      else if (method === "POST" && route === "bookings" && !segments[1]) {
        await verifyChallenge(body, ip);
        result = await engine.create(body, { ip });
      } else if (method === "POST" && route === "cancel")
        result = await engine.cancel(safeId(segments[1]), body.token);
      else if (route === "admin") {
        const user = await authenticate(headers.authorization || "");
        const resource = segments[1],
          id = segments[2];
        if (resource === "settings" && method === "GET")
          result = await engine.adminSettings(user);
        else if (resource === "pending" && method === "GET")
          result = await engine.pending(user, query.after);
        else if (resource === "settings" && method === "PUT")
          result = await engine.saveSettings(user, body);
        else if (resource === "bookings" && method === "GET")
          result = await engine.list(user, query);
        else if (resource === "bookings" && method === "POST")
          result = await engine.create(body, { user, ip });
        else if (resource === "bookings" && method === "PATCH")
          result = await engine.update(safeId(id), body, user);
        else if (resource === "payments" && method === "POST")
          result = await engine.payment(user, safeId(id), body);
        else if (resource === "shifts" && method === "PUT")
          result = await engine.shift(user, body);
        else if (resource === "shifts" && method === "GET")
          result = await engine.getShift(user, query.masterId, query.date);
        else if (resource === "customers" && !id && method === "GET")
          result = await engine.customers(user, query.after);
        else if (resource === "customers" && id && method === "GET")
          result = await engine.customer(user, safeId(id));
        else if (resource === "customers" && id && method === "PATCH")
          result = await engine.customer(user, safeId(id), body.notes);
        else if (resource === "customers" && id && method === "DELETE")
          result = await engine.anonymize(user, safeId(id));
        else if (resource === "members" && method === "GET")
          result = await engine.members(user);
        else if (resource === "members" && method === "PUT")
          result = await engine.members(user, body);
        else if (resource === "audit" && method === "GET")
          result = await engine.auditLog(user, query.after);
        else if (resource === "export" && method === "GET")
          result = await engine.export(user);
        else throw new Problem(404, "Метод не найден");
      } else throw new Problem(404, "Метод не найден");
      return { status: 200, headers: common, body: JSON.stringify(result) };
    } catch (error) {
      if (!(error instanceof Problem))
        console.error("API failure", error.code || error.name);
      return {
        status: error.status || 500,
        headers: common,
        body: JSON.stringify({
          error: error.status
            ? error.message
            : "Сервис временно недоступен. Свяжитесь с салоном",
        }),
      };
    }
  };
}
module.exports = { handler };
