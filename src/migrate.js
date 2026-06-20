// src/migrate.js
//
// One-off Docker data migration helper.
//
// Copies legacy bind-mounted data from /app/legacy-data into the new Docker
// named volume mounted at /app/data.
//
// Intended Compose usage:
//   docker compose --profile migrate run --rm migrate-data
//
// This script is deliberately conservative:
//   - it does not delete the old ./data directory
//   - it refuses to copy over an existing non-empty /app/data directory
//   - it copies everything from the legacy data directory, including SQLite
//     sidecar files such as -wal and -shm

const fs = require("fs");
const path = require("path");

const fsp = fs.promises;

const LEGACY_DATA_DIR = process.env.LEGACY_DATA_DIR || "/app/legacy-data";
const TARGET_DATA_DIR = process.env.DATA_DIR || "/app/data";

function log(message) {
  console.log(`[xannyblastr migrate] ${message}`);
}

function fail(message) {
  console.error(`[xannyblastr migrate] ERROR: ${message}`);
  process.exitCode = 1;
}

async function exists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function assertDirectory(targetPath, label) {
  let stat;

  try {
    stat = await fsp.stat(targetPath);
  } catch {
    return false;
  }

  if (!stat.isDirectory()) {
    fail(`${label} exists but is not a directory: ${targetPath}`);
    return false;
  }

  return true;
}

async function listUsefulEntries(directoryPath) {
  const entries = await fsp.readdir(directoryPath);

  // Ignore common junk files only. Do not ignore SQLite files or hidden app data.
  return entries.filter((entry) => entry !== ".DS_Store");
}

async function copyDirectoryContents(sourceDir, targetDir) {
  const entries = await listUsefulEntries(sourceDir);

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry);
    const targetPath = path.join(targetDir, entry);

    await fsp.cp(sourcePath, targetPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
  }
}

async function main() {
  log(`Legacy data directory: ${LEGACY_DATA_DIR}`);
  log(`Target data directory: ${TARGET_DATA_DIR}`);

  const legacyExists = await exists(LEGACY_DATA_DIR);

  if (!legacyExists) {
    log("No legacy data directory is mounted. Nothing to migrate.");
    return;
  }

  const legacyIsDirectory = await assertDirectory(LEGACY_DATA_DIR, "Legacy data path");
  if (!legacyIsDirectory) {
    return;
  }

  const legacyEntries = await listUsefulEntries(LEGACY_DATA_DIR);

  if (legacyEntries.length === 0) {
    log("Legacy data directory exists but is empty. Nothing to migrate.");
    return;
  }

  await fsp.mkdir(TARGET_DATA_DIR, { recursive: true });

  const targetIsDirectory = await assertDirectory(TARGET_DATA_DIR, "Target data path");
  if (!targetIsDirectory) {
    return;
  }

  const targetEntries = await listUsefulEntries(TARGET_DATA_DIR);

  if (targetEntries.length > 0) {
    fail(
      [
        "Target data directory is not empty, so migration has been refused.",
        "",
        "This prevents accidentally overwriting an existing Docker volume database.",
        "",
        `Target path: ${TARGET_DATA_DIR}`,
        `Existing entries: ${targetEntries.join(", ")}`,
        "",
        "If you intended to start fresh, do not run the migration.",
        "If you intended to migrate old data, inspect the Docker volume first.",
      ].join("\n")
    );
    return;
  }

  log(`Found ${legacyEntries.length} legacy data entr${legacyEntries.length === 1 ? "y" : "ies"}.`);
  log("Copying legacy data into Docker volume...");

  try {
    await copyDirectoryContents(LEGACY_DATA_DIR, TARGET_DATA_DIR);
  } catch (error) {
    fail(`Migration failed while copying files: ${error.message}`);
    return;
  }

  const migratedEntries = await listUsefulEntries(TARGET_DATA_DIR);

  log("Migration complete.");
  log(`Copied entries: ${migratedEntries.join(", ")}`);
  log("The old ./data directory has not been deleted. Keep it as a backup until you have verified the relay.");
}

main().catch((error) => {
  fail(error && error.stack ? error.stack : String(error));
});