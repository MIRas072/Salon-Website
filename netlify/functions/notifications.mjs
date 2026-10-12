import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { runtime } = require("../../backend/firebase.cjs");
const { deliver } = require("../../backend/notifications.cjs");
export default async () => {
  if (!process.env.RESEND_API_KEY)
    return new Response(JSON.stringify({ enabled: false }));
  const result = await deliver(runtime().engine);
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json" },
  });
};
export const config = { schedule: "*/15 * * * *" };
