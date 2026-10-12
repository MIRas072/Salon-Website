"use strict";
const fs = require("node:fs");
const { prepareLegacy, importLegacy } = require("../backend/migration.cjs"),
  defaults = require("../backend/defaults.cjs");
(async () => {
  const { runtime } = require("../backend/firebase.cjs");
  const { engine } = runtime();
  const { getFirestore } = require("firebase-admin/firestore");
  const db = getFirestore();
  const snapshot = await db.collection("bookings").get();
  const rows = snapshot.docs.map((d) => {
    const b = d.data();
    return {
      ...b,
      id: d.id,
      createdAt: b.createdAt?.toMillis?.() || b.createdAt || Date.now(),
    };
  });
  const backup = process.env.LEGACY_BACKUP_PATH;
  if (!backup)
    throw new Error(
      "Укажите LEGACY_BACKUP_PATH для закрытой копии исходных записей",
    );
  fs.writeFileSync(backup, JSON.stringify(rows, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  const settings = { ...structuredClone(defaults), version: 1 };
  const prepared = prepareLegacy(rows, settings);
  console.log(
    JSON.stringify({
      records: prepared.records.length,
      slots: prepared.slots.length,
      needsDurationReview: prepared.needsDurationReview,
      mode: process.argv.includes("--apply") ? "apply" : "dry-run",
    }),
  );
  if (process.argv.includes("--apply")) {
    if (process.env.MIGRATION_EXPECT_PROJECT !== db.projectId)
      throw new Error(
        "MIGRATION_EXPECT_PROJECT должен точно совпадать с целевым Firebase-проектом",
      );
    const result = await importLegacy(engine.store, prepared, settings);
    console.log(JSON.stringify(result));
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
