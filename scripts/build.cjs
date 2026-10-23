"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const root = path.resolve(__dirname, ".."),
  out = path.join(root, "dist");
fs.mkdirSync(out, { recursive: true });
// An explicit allowlist prevents backend credentials, backups and tests from becoming public.
for (const name of [
  "index.html",
  "style.css",
  "luxury.css",
  "booking.js",
  "admin.html",
  "admin.css",
  "admin.js",
  "firebase-config.js",
  "schedule.js",
  "robots.txt",
  "sitemap.xml",
])
  fs.copyFileSync(path.join(root, name), path.join(out, name));
fs.cpSync(path.join(root, "next"), path.join(out, "next"), { recursive: true });
fs.cpSync(path.join(root, "assets"), path.join(out, "assets"), {
  recursive: true,
});
console.log(
  "Built current site and isolated /next preview; server and local data excluded.",
);
