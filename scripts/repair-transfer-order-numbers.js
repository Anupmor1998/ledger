require("dotenv").config();

const { Client } = require("pg");

const TRANSFER_ORDER_NO_BASE = 100000;

function parseArgs(argv) {
  const args = {
    apply: false,
    target: "local",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") {
      args.apply = true;
    }
    if (token === "--prod") {
      args.target = "prod";
    }
    if (token === "--local") {
      args.target = "local";
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const isProd = args.target === "prod";

  const connectionString = isProd
    ? process.env.PROD_DATABASE_URL || process.env.DATABASE_URL
    : process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(`Database connection string not found for target: ${args.target}`);
  }

  console.log(`\n======================================================`);
  console.log(`Repairing Transferred Order Numbers (Option 1)`);
  console.log(`Target: ${args.target.toUpperCase()} (${isProd ? "PRODUCTION" : "LOCAL"})`);
  console.log(`Mode: ${args.apply ? "LIVE APPLY" : "DRY RUN (pass --apply to execute)"}`);
  console.log(`======================================================\n`);

  const client = new Client({ connectionString });
  await client.connect();

  try {
    // 1. Find all carried forward orders with orderNo below the transfer base
    const query = `
      SELECT
        o.id,
        o."userId",
        o."fyStartYear",
        o."orderNo",
        o."originalOrderNo",
        o."orderDate",
        u.email as "userEmail"
      FROM "Order" o
      JOIN "User" u ON u.id = o."userId"
      WHERE (o."isCarryForward" = true OR o."carriedForwardFromOrderId" IS NOT NULL)
        AND o."orderNo" < $1
      ORDER BY o."userId" ASC, o."fyStartYear" ASC, o."orderNo" ASC
    `;

    const res = await client.query(query, [TRANSFER_ORDER_NO_BASE]);
    const ordersToRepair = res.rows;

    if (ordersToRepair.length === 0) {
      console.log("No transferred orders found with legacy order numbers (< 100000). Nothing to repair!");
      return;
    }

    console.log(`Found ${ordersToRepair.length} transferred order(s) to renumber into 100000+ range:\n`);

    // Group by userId and fyStartYear to assign sequential 100000+ numbers per partition
    const grouped = new Map();
    for (const order of ordersToRepair) {
      const key = `${order.userId}__${order.fyStartYear}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key).push(order);
    }

    const plannedUpdates = [];

    for (const [key, orders] of grouped.entries()) {
      const [userId, fyStartYearStr] = key.split("__");
      const fyStartYear = parseInt(fyStartYearStr, 10);

      // Find highest orderNo already in 100000+ range for this partition
      const maxRes = await client.query(
        `SELECT COALESCE(MAX("orderNo"), $1) as "maxOrderNo"
         FROM "Order"
         WHERE "userId" = $2 AND "fyStartYear" = $3 AND "orderNo" >= $1`,
        [TRANSFER_ORDER_NO_BASE, userId, fyStartYear]
      );
      let nextTransferNo = Math.max(TRANSFER_ORDER_NO_BASE, Number(maxRes.rows[0].maxOrderNo || TRANSFER_ORDER_NO_BASE)) + 1;

      for (const order of orders) {
        const assignedNo = nextTransferNo;
        nextTransferNo += 1;

        // Ensure originalOrderNo is preserved so UI display (#origNo#) remains unchanged
        const origNo = order.originalOrderNo || order.orderNo;

        plannedUpdates.push({
          id: order.id,
          userEmail: order.userEmail,
          fyStartYear: order.fyStartYear,
          oldOrderNo: order.orderNo,
          newOrderNo: assignedNo,
          originalOrderNo: origNo,
        });
      }
    }

    // Print summary table
    console.log(
      `| User | FY | Old orderNo | New orderNo | UI Displayed No | Order ID |`
    );
    console.log(`|---|---|---|---|---|---|`);
    for (const u of plannedUpdates) {
      console.log(
        `| ${u.userEmail} | ${u.fyStartYear} | ${u.oldOrderNo} | ${u.newOrderNo} | #${u.originalOrderNo}# | ${u.id} |`
      );
    }

    if (!args.apply) {
      console.log(`\n[DRY RUN] No changes were written. Re-run with '--apply' to execute this repair.`);
      return;
    }

    // 2. Execute updates in a transaction
    console.log(`\nExecuting updates in transaction...`);
    await client.query("BEGIN");

    for (const u of plannedUpdates) {
      await client.query(
        `UPDATE "Order"
         SET "orderNo" = $1, "originalOrderNo" = $2
         WHERE id = $3`,
        [u.newOrderNo, u.originalOrderNo, u.id]
      );
    }

    await client.query("COMMIT");
    console.log(`SUCCESS: Successfully renumbered ${plannedUpdates.length} transferred order(s) into 100000+ range.`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("\nRepair failed:", err);
  process.exit(1);
});

