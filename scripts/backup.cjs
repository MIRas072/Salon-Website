"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const { SQLiteStore } = require("../backend/store.cjs"),
  { Engine } = require("../backend/engine.cjs"),
  { restoreEmpty } = require("../backend/backup.cjs");
(async () => {
  const [action, file] = process.argv.slice(2);
  if (!["export", "restore"].includes(action) || !file)
    throw new Error(
      "Использование: npm run backup -- export /private/backup.json или restore /private/backup.json. SALON_LOCAL_DB указывает локальную базу.",
    );
  const target =
    process.env.SALON_LOCAL_DB ||
    path.resolve(__dirname, "../.local/salon.sqlite");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const cloud = process.env.SALON_BACKUP_TARGET === "firebase";
  const cloudEngine = cloud
    ? require("../backend/firebase.cjs").runtime().engine
    : null;
  if (
    cloud &&
    action === "restore" &&
    process.env.RESTORE_EXPECT_PROJECT !== process.env.FIREBASE_PROJECT_ID
  )
    throw new Error(
      "RESTORE_EXPECT_PROJECT должен совпадать с целевым проектом. Восстановление допускается только в пустые V2-коллекции.",
    );
  const store = cloud ? cloudEngine.store : new SQLiteStore(target);
  try {
    if (action === "export") {
      const e = cloudEngine || new Engine(store);
      const data = await e.export({
        uid: "backup-tool",
        email: e.ownerEmail,
        emailVerified: true,
      });
      fs.writeFileSync(file, JSON.stringify(data, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      console.log("Backup saved with private permissions.");
    } else {
      await restoreEmpty(store, JSON.parse(fs.readFileSync(file, "utf8")));
      console.log(
        cloud
          ? "Restored into empty Firebase V2 collections. Legacy collections were not touched."
          : "Restored into empty local database. Production Firebase was not touched.",
      );
    }
  } finally {
    if (store.close) store.close();
    else await require("firebase-admin/firestore").getFirestore().terminate();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
