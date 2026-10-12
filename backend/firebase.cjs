"use strict";
const { FirestoreStore } = require("./store.cjs");
const { Engine, Problem } = require("./engine.cjs");
let instance;
function runtime() {
  if (instance) return instance;
  const { initializeApp, cert, getApps } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const { getAuth } = require("firebase-admin/auth");
  if (
    !process.env.FIREBASE_SERVICE_ACCOUNT &&
    !process.env.FIRESTORE_EMULATOR_HOST
  )
    throw new Problem(503, "Серверный доступ к базе ещё не настроен");
  let key;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    key = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (
      !process.env.FIREBASE_PROJECT_ID ||
      key.project_id !== process.env.FIREBASE_PROJECT_ID
    )
      throw new Problem(503, "Проверьте проект серверного ключа Firebase");
  }
  const app =
    getApps()[0] ||
    initializeApp(
      key
        ? { credential: cert(key), projectId: process.env.FIREBASE_PROJECT_ID }
        : { projectId: process.env.FIREBASE_PROJECT_ID || "demo-salon-v2" },
    );
  const engine = new Engine(new FirestoreStore(getFirestore(app)));
  const authenticate = async (header) => {
    if (!header.startsWith("Bearer "))
      throw new Problem(401, "Войдите в кабинет");
    try {
      const t = await getAuth(app).verifyIdToken(header.slice(7), true);
      return {
        uid: t.uid,
        email: t.email,
        emailVerified: t.email_verified === true,
      };
    } catch {
      throw new Problem(401, "Сессия истекла. Войдите снова");
    }
  };
  const verifyChallenge = async (body, ip) => {
    if (!process.env.TURNSTILE_SECRET_KEY) return;
    if (!body.challengeToken)
      throw new Problem(400, "Пройдите проверку от роботов");
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: new URLSearchParams({
          secret: process.env.TURNSTILE_SECRET_KEY,
          response: body.challengeToken,
          remoteip: ip,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    const result = await response.json();
    const hostname = new URL(process.env.SITE_URL).hostname;
    if (
      !result.success ||
      result.hostname !== hostname ||
      result.action !== "booking"
    )
      throw new Problem(400, "Проверка не пройдена. Повторите её");
  };
  return (instance = { engine, authenticate, verifyChallenge });
}
module.exports = { runtime };
