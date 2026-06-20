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
// Behaviour:
//   - if /app/data is empty, migration runs automatically
//   - if /app/data already contains files, the user is asked to confirm overwrite
//   -    (in case user restarts service before migration by accident, totally unlike me...)
//   - if confirmed, existing /app/data contents are removed before copying
//   - /app/legacy-data is mounted read-only and is never modified
//   - SQLite sidecar files such as blastr.db-wal and blastr.db-shm are copied too

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

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
    fail(`${label} does not exist: ${targetPath}`);
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

function assertSafeTargetPath(targetPath) {
  const resolved = path.resolve(targetPath);

  if (resolved === "/" || resolved.length < 5) {
    fail(`Refusing to wipe unsafe target path: ${targetPath}`);
    return false;
  }

  return true;
}

async function askForOverwriteConfirmation(targetEntries) {
  log("Target data directory is not empty.");
  log("Existing target entries:");

  for (const entry of targetEntries) {
    console.log(`  - ${entry}`);
  }

  console.log("");
  log("This migration will DELETE the existing target data listed above.");
  log("It will then copy the old legacy ./data contents into the Docker volume.");
  log("The old legacy ./data directory will NOT be deleted or modified.");
  console.log("");

  const rl = readline.createInterface({ input, output });

  try {
    const answer = await rl.question(
      'Type "overwrite" to continue, or anything else to cancel: '
    );

    return answer.trim().toLowerCase() === "overwrite";
  } finally {
    rl.close();
  }
}

async function clearDirectoryContents(directoryPath) {
  const entries = await fsp.readdir(directoryPath);

  for (const entry of entries) {
    if (entry === ".DS_Store") {
      continue;
    }

    const targetPath = path.join(directoryPath, entry);

    log(`Removing existing target entry: ${targetPath}`);

    await fsp.rm(targetPath, {
      recursive: true,
      force: true,
    });
  }
}

async function copyDirectoryContents(sourceDir, targetDir) {
  const entries = await listUsefulEntries(sourceDir);

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry);
    const targetPath = path.join(targetDir, entry);

    log(`Copying ${sourcePath} -> ${targetPath}`);

    await fsp.cp(sourcePath, targetPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
      preserveTimestamps: true,
    });
  }
}

async function main() {
  log("Starting Docker data migration.");
  log(`Legacy data directory: ${LEGACY_DATA_DIR}`);
  log(`Target data directory: ${TARGET_DATA_DIR}`);

  if (!assertSafeTargetPath(TARGET_DATA_DIR)) {
    return;
  }

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
    const confirmed = await askForOverwriteConfirmation(targetEntries);

    if (!confirmed) {
      log("Migration cancelled. No files were changed.");
      return;
    }

    log("Overwrite confirmed.");
    log("Clearing target data directory...");

    try {
      await clearDirectoryContents(TARGET_DATA_DIR);
    } catch (error) {
      fail(`Failed while clearing target data directory: ${error.message}`);
      return;
    }
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