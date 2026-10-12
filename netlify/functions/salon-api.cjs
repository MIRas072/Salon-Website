"use strict";
const { runtime } = require("../../backend/firebase.cjs"),
  { handler } = require("../../backend/http.cjs");
exports.handler = async (event) => {
  try {
    if (Buffer.byteLength(event.body || "") > 65536)
      return {
        statusCode: 413,
        body: JSON.stringify({ error: "Слишком большой запрос" }),
      };
    const rt = runtime(),
      api = handler(rt.engine, rt.authenticate, {
        verifyChallenge: rt.verifyChallenge,
      });
    const r = await api({
      method: event.httpMethod,
      path: event.path,
      query: event.queryStringParameters || {},
      body: event.body
        ? JSON.parse(
            event.isBase64Encoded
              ? Buffer.from(event.body, "base64").toString()
              : event.body,
          )
        : {},
      headers: event.headers,
      ip: event.headers["x-nf-client-connection-ip"] || "unknown",
    });
    return { statusCode: r.status, headers: r.headers, body: r.body };
  } catch (e) {
    return {
      statusCode: e.status || 503,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        error: e.status ? e.message : "Сервер временно недоступен",
      }),
    };
  }
};
