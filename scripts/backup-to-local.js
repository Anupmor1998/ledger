require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pipeline } = require("stream/promises");
const { createGzip } = require("zlib");

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_DB_NAME = "ledger";
const BACKUP_DIR = path.resolve(__dirname, "../../backup");

function getSourceDatabaseUrl() {
  return process.env.PROD_DATABASE_URL || process.env.DATABASE_URL;
}

function getTimestampParts(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return { year, month, day, hour, minute, second };
}

function buildBackupBaseName() {
  const { year, month, day, hour, minute, second } = getTimestampParts();
  const dbName = process.env.BACKUP_DB_NAME || DEFAULT_DB_NAME;
  return `${dbName}-${year}${month}${day}-${hour}${minute}${second}`;
}

function getRetentionMs() {
  const days = Number(process.env.BACKUP_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
}

async function ensureBackupDir() {
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
}

async function cleanupOldBackups() {
  const retentionMs = getRetentionMs();
  const now = Date.now();
  const entries = await fs.promises.readdir(BACKUP_DIR, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }

      const filePath = path.join(BACKUP_DIR, entry.name);
      const stats = await fs.promises.stat(filePath);
      if (now - stats.mtimeMs > retentionMs) {
        await fs.promises.unlink(filePath);
      }
    })
  );
}

async function writeChecksum(filePath) {
  const hash = crypto.createHash("sha256");
  const readStream = fs.createReadStream(filePath);

  for await (const chunk of readStream) {
    hash.update(chunk);
  }

  const checksum = hash.digest("hex");
  await fs.promises.writeFile(`${filePath}.sha256`, `${checksum}  ${path.basename(filePath)}\n`, "utf8");
}

async function createBackup() {
  const databaseUrl = getSourceDatabaseUrl();
  if (!databaseUrl) {
    throw new Error("PROD_DATABASE_URL or DATABASE_URL is required");
  }

  await ensureBackupDir();

  const baseName = buildBackupBaseName();
  const backupFilePath = path.join(BACKUP_DIR, `${baseName}.sql.gz`);
  const pgDumpBin = process.env.PG_DUMP_BIN || "pg_dump";

  const dumpProcess = spawn(
    pgDumpBin,
    ["--dbname", databaseUrl, "--no-owner", "--no-privileges", "--format=plain"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );

  let stderr = "";
  dumpProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const gzip = createGzip({ level: 9 });
  const output = fs.createWriteStream(backupFilePath);

  try {
    await pipeline(dumpProcess.stdout, gzip, output);
  } catch (error) {
    throw new Error(`Backup stream failed: ${error.message}`);
  }

  const exitCode = await new Promise((resolve, reject) => {
    dumpProcess.on("error", reject);
    dumpProcess.on("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `pg_dump failed with exit code ${exitCode}`);
  }

  await writeChecksum(backupFilePath);
  await cleanupOldBackups();

  return backupFilePath;
}

createBackup()
  .then((filePath) => {
    console.log(`Backup created: ${filePath}`);
  })
  .catch((error) => {
    console.error(`Backup failed: ${error.message}`);
    process.exit(1);
  });
