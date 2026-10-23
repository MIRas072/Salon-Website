"use strict";
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { SQLiteStore } = require("./store.cjs"),
  { Engine, Problem } = require("./engine.cjs"),
  { handler } = require("./http.cjs");
const root = path.resolve(__dirname, "..");
fs.mkdirSync(path.join(root, ".local"), { recursive: true });
const store = new SQLiteStore(
  process.env.SALON_LOCAL_DB || path.join(root, ".local", "salon.sqlite"),
);
const engine = new Engine(store),
  session = crypto.randomBytes(32).toString("hex");
const api = handler(
  engine,
  async (auth) => {
    if (auth !== `Bearer ${session}`)
      throw new Problem(401, "Войдите в локальный кабинет");
    return {
      uid: "local-owner",
      email: engine.ownerEmail,
      emailVerified: true,
    };
  },
  { development: true },
);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost"),
    origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (url.pathname === "/api/v2/dev-session" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ token: session, development: true }));
    return;
  }
  if (url.pathname.startsWith("/api/v2/")) {
    let data = "";
    try {
      for await (const chunk of req) {
        data += chunk;
        if (Buffer.byteLength(data) > 65536)
          throw new Problem(413, "Слишком большой запрос");
      }
      const result = await api({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: data ? JSON.parse(data) : {},
        headers: req.headers,
        ip: req.socket.remoteAddress,
      });
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (e) {
      res.writeHead(e.status || 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  const requested = decodeURIComponent(
    url.pathname === "/" ? "/next/index.html" : url.pathname,
  );
  const file = path.resolve(root, "." + requested);
  if (
    !file.startsWith(root + path.sep) ||
    !(
      /\/next\/[\w.-]+\.(html|js|css|svg)$/.test(file) ||
      [
        root + "/style.css",
        root + "/luxury.css",
        root + "/admin.css",
        root + "/firebase-config.js",
      ].includes(file) ||
      /^assets\/luxury-[\w-]+\.(jpg|webp|png)$/.test(path.relative(root, file))
    )
  ) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, {
      "Content-Type": {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".jpg": "image/jpeg",
        ".webp": "image/webp",
        ".png": "image/png",
      }[path.extname(file)],
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.listen(Number(process.env.PORT || 8030), "127.0.0.1", () =>
  console.log(
    "Development server ready on port " +
      server.address().port +
      "; local SQLite only; production data untouched.",
  ),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
