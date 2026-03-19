require("dotenv").config();

const { Client } = require("pg");

const TABLES = [
  "User",
  "PasswordResetToken",
  "Customer",
  "Manufacturer",
  "Quality",
  "WhatsAppGroup",
  "Order",
];

const BATCH_SIZE = 100;

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getFirstAvailableEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }
  throw new Error(`${names.join(" or ")} is required`);
}

function parseConnectionUrl(connectionString) {
  try {
    return new URL(connectionString);
  } catch {
    throw new Error(`Invalid connection string: ${connectionString}`);
  }
}

function isLocalHostname(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(String(hostname || "").toLowerCase());
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, "\"\"")}"`;
}

async function getTableColumns(client, tableName) {
  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position ASC
    `,
    [tableName]
  );

  return result.rows.map((row) => row.column_name);
}

async function readRows(client, tableName, columns) {
  const columnList = columns.map(quoteIdentifier).join(", ");
  const result = await client.query(`SELECT ${columnList} FROM ${quoteIdentifier(tableName)}`);
  return result.rows;
}

async function insertRows(client, tableName, columns, rows) {
  if (!rows.length) {
    return;
  }

  const columnList = columns.map(quoteIdentifier).join(", ");

  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const chunk = rows.slice(offset, offset + BATCH_SIZE);
    const values = [];
    const placeholders = chunk.map((row, rowIndex) => {
      const rowPlaceholders = columns.map((column, columnIndex) => {
        values.push(row[column]);
        return `$${rowIndex * columns.length + columnIndex + 1}`;
      });
      return `(${rowPlaceholders.join(", ")})`;
    });

    await client.query(
      `INSERT INTO ${quoteIdentifier(tableName)} (${columnList}) VALUES ${placeholders.join(", ")}`,
      values
    );
  }
}

async function syncTable(sourceClient, targetClient, tableName) {
  const columns = await getTableColumns(targetClient, tableName);
  const rows = await readRows(sourceClient, tableName, columns);
  await insertRows(targetClient, tableName, columns, rows);
  console.log(`Synced ${tableName}: ${rows.length} row(s)`);
}

async function main() {
  const sourceUrl = getFirstAvailableEnv(["PROD_DATABASE_URL", "DATABASE_URL"]);
  const targetUrl = getRequiredEnv("LOCAL_DATABASE_URL");

  if (sourceUrl === targetUrl) {
    throw new Error("PROD_DATABASE_URL and LOCAL_DATABASE_URL must be different");
  }

  const sourceParsed = parseConnectionUrl(sourceUrl);
  const targetParsed = parseConnectionUrl(targetUrl);

  if (isLocalHostname(sourceParsed.hostname)) {
    throw new Error("PROD_DATABASE_URL must not point to a local database");
  }

  if (!isLocalHostname(targetParsed.hostname)) {
    throw new Error("LOCAL_DATABASE_URL must point to a local database");
  }

  const sourceClient = new Client({ connectionString: sourceUrl });
  const targetClient = new Client({ connectionString: targetUrl });

  await sourceClient.connect();
  await targetClient.connect();

  try {
    await targetClient.query("BEGIN");
    await targetClient.query(
      `TRUNCATE TABLE ${TABLES.map(quoteIdentifier).join(", ")} RESTART IDENTITY CASCADE`
    );

    for (const tableName of TABLES) {
      await syncTable(sourceClient, targetClient, tableName);
    }

    await targetClient.query("COMMIT");
    console.log("Production data copied to local database successfully.");
  } catch (error) {
    await targetClient.query("ROLLBACK");
    throw error;
  } finally {
    await sourceClient.end();
    await targetClient.end();
  }
}

main().catch((error) => {
  console.error(`Sync failed: ${error.message}`);
  process.exit(1);
});
