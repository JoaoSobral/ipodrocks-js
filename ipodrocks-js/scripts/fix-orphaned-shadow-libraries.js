/**
 * Diagnose/repair `shadow_libraries` rows left behind after a shadow library
 * stopped resolving its codec configuration (e.g. after a downgrade/upgrade
 * round trip). Such a row is invisible to the app — `getShadowLibraries()`
 * INNER JOINs against `codec_configurations`/`codecs`, so a row with a dead
 * `codec_config_id` never shows in the Library panel — but its `name` and
 * `path` UNIQUE constraints still block creating a new shadow library with
 * the same name or folder, surfacing as a raw
 * "UNIQUE constraint failed: shadow_libraries.name" (or `.path`) error.
 *
 * Run from the ipodrocks-js project directory (uses its own node_modules —
 * no extra install needed):
 *
 *   node scripts/fix-orphaned-shadow-libraries.js /path/to/ipodrocks.db
 *   node scripts/fix-orphaned-shadow-libraries.js /path/to/ipodrocks.db --apply
 *
 * `better-sqlite3` is a native addon; if `npm install`/`electron-rebuild`
 * last built it against Electron's Node ABI rather than your system Node,
 * plain `node` will fail to load it with an "NODE_MODULE_VERSION" error.
 * If that happens, run it through Electron's own bundled Node instead
 * (still nothing extra to install — electron is already a project
 * dependency):
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/fix-orphaned-shadow-libraries.js /path/to/ipodrocks.db
 *
 * Without --apply this only lists what it would remove (dry run). With
 * --apply it first copies the db file to a timestamped .bak next to it,
 * then removes the offending rows the same way the app's own
 * `deleteShadowLibrary()` does: clear any device pointing at the row, then
 * delete it (which cascades to its `shadow_tracks` rows). It never touches
 * files on disk — the transcoded folder is left intact so the app can adopt
 * it when the shadow library is recreated.
 */
const fs = require("fs");
const path = require("path");

const Database = require("better-sqlite3");

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dbPath = args.find((a) => !a.startsWith("--"));

  if (!dbPath) {
    console.error(
      "Usage: node scripts/fix-orphaned-shadow-libraries.js <path-to-ipodrocks.db> [--apply]"
    );
    process.exit(1);
  }
  const resolvedDbPath = path.resolve(dbPath);
  if (!fs.existsSync(resolvedDbPath)) {
    console.error(`Database file not found: ${resolvedDbPath}`);
    process.exit(1);
  }

  const db = new Database(resolvedDbPath);
  db.pragma("foreign_keys = ON");

  const orphans = db
    .prepare(
      `SELECT sl.id, sl.name, sl.path, sl.codec_config_id, sl.status
       FROM shadow_libraries sl
       LEFT JOIN codec_configurations cc ON sl.codec_config_id = cc.id
       WHERE cc.id IS NULL`
    )
    .all();

  if (orphans.length === 0) {
    console.log("No orphaned shadow_libraries rows found. Nothing to do.");
    db.close();
    return;
  }

  console.log(`Found ${orphans.length} orphaned shadow_libraries row(s):\n`);
  for (const row of orphans) {
    console.log(
      `  #${row.id}  name="${row.name}"  path="${row.path}"  status=${row.status}  codec_config_id=${row.codec_config_id} (no longer exists)`
    );
  }

  if (!apply) {
    console.log(
      "\nDry run only — no changes made. Re-run with --apply to delete these rows."
    );
    db.close();
    return;
  }

  const backupPath = `${resolvedDbPath}.bak-${Date.now()}`;
  fs.copyFileSync(resolvedDbPath, backupPath);
  console.log(`\nBacked up database to ${backupPath}`);

  const clearDeviceRef = db.prepare(
    "UPDATE devices SET shadow_library_id = NULL WHERE shadow_library_id = ?"
  );
  const deleteLib = db.prepare("DELETE FROM shadow_libraries WHERE id = ?");

  const removeAll = db.transaction((rows) => {
    for (const row of rows) {
      clearDeviceRef.run(row.id);
      deleteLib.run(row.id); // shadow_tracks cascade via ON DELETE CASCADE
    }
  });
  removeAll(orphans);

  console.log(
    `Removed ${orphans.length} orphaned row(s). Files on disk were not touched — ` +
      `recreate the shadow library with the same name/path in the app and it will adopt them.`
  );
  db.close();
}

main();
