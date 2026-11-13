const dotenv = require("dotenv");
dotenv.config();
const { Pool } = require("pg");

async function clearAdvisoryLocks() {
  const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    return;
  }

  // Use a short 10s connection timeout so it never hangs the build
  const pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: 10000,
  });

  try {
    // 1. Terminate any orphaned backend process holding Prisma's migration lock (72707369)
    await pool.query(`
      SELECT pg_terminate_backend(l.pid)
      FROM pg_locks l
      JOIN pg_stat_activity a ON l.pid = a.pid
      WHERE l.locktype = 'advisory'
        AND l.objid = 72707369
        AND l.pid <> pg_backend_pid();
    `);

    // 2. Release all advisory locks on this session as a safety measure
    await pool.query("SELECT pg_advisory_unlock_all();");
    console.log("Pre-deploy: database advisory lock check passed cleanly.");
  } catch (err) {
    // Warning only: never block deployment if lock check encounters a transient error
    console.warn("Pre-deploy: advisory lock check warning (non-fatal):", err.message);
  } finally {
    try {
      await pool.end();
    } catch (_e) {}
  }
}

clearAdvisoryLocks()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
