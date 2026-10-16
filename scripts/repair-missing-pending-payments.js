require("dotenv").config();

const prisma = require("../src/config/prisma");
const {
  getNextPendingPaymentSerialNo,
  isPendingPaymentSerialConflict,
  round2,
} = require("../src/utils/payments");

const RETRY_LIMIT = 5;

function addDays(dateValue, days) {
  if (!Number.isFinite(days)) {
    return null;
  }
  const date = new Date(dateValue);
  date.setDate(date.getDate() + days);
  return date;
}

function parseCliArgs(argv) {
  const flags = {
    apply: false,
    email: null,
    orderNo: null,
    fy: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      flags.apply = true;
    } else if (arg === "--dry-run") {
      flags.apply = false;
    } else if (arg === "--email" && argv[i + 1]) {
      flags.email = String(argv[i + 1]).trim().toLowerCase();
      i += 1;
    } else if (arg === "--order-no" && argv[i + 1]) {
      flags.orderNo = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--fy" && argv[i + 1]) {
      flags.fy = Number(argv[i + 1]);
      i += 1;
    }
  }

  return flags;
}

async function createPendingPaymentForOrder(tx, order) {
  const amountDue = round2(order.commissionAmount || 0);
  if (amountDue <= 0) {
    return null;
  }

  const accountName = String(
    order?.customer?.firmName || order?.customer?.name || "Customer"
  ).trim();

  const paymentDueOn = Number(order?.paymentDueOn);
  const dueDate =
    Number.isInteger(paymentDueOn) && paymentDueOn >= 0
      ? addDays(order.orderDate, paymentDueOn)
      : null;

  for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
    try {
      const serialNo = await getNextPendingPaymentSerialNo(
        tx,
        order.userId,
        order.fyStartYear
      );

      const created = await tx.pendingPayment.create({
        data: {
          userId: order.userId,
          orderId: order.id,
          fyStartYear: order.fyStartYear,
          serialNo,
          accountName,
          amountDue,
          amountReceived: 0,
          finalSettledAmount: null,
          discountAmount: 0,
          discountPercent: 0,
          balanceAmount: amountDue,
          status: "PENDING",
          dueDate,
        },
      });

      return created;
    } catch (error) {
      if (isPendingPaymentSerialConflict(error) && attempt < RETRY_LIMIT - 1) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Failed to assign unique serialNo after ${RETRY_LIMIT} attempts.`);
}

async function main() {
  const flags = parseCliArgs(process.argv);

  console.log("=================================================");
  console.log("  Repair Missing Pending Payments");
  console.log("=================================================");
  console.log(`Mode     : ${flags.apply ? "APPLY (writes to DB)" : "DRY RUN (preview only)"}`);
  if (flags.email) console.log(`Email    : ${flags.email}`);
  if (flags.orderNo) console.log(`Order No : ${flags.orderNo}`);
  if (flags.fy) console.log(`FY Start : ${flags.fy}`);
  console.log("-------------------------------------------------");

  const whereClause = {
    status: "COMPLETED",
    commissionAmount: { gt: 0 },
    pendingPayment: null,
  };

  if (flags.email) {
    whereClause.user = { email: flags.email };
  }
  if (flags.orderNo) {
    whereClause.orderNo = flags.orderNo;
  }
  if (flags.fy) {
    whereClause.fyStartYear = flags.fy;
  }

  const missingOrders = await prisma.order.findMany({
    where: whereClause,
    include: {
      user: { select: { id: true, email: true, name: true } },
      customer: { select: { id: true, firmName: true, name: true } },
    },
    orderBy: [
      { userId: "asc" },
      { fyStartYear: "asc" },
      { orderNo: "asc" },
    ],
  });

  if (missingOrders.length === 0) {
    console.log("No completed orders with missing PendingPayment records found matching criteria.");
    return;
  }

  console.log(`Found ${missingOrders.length} order(s) missing PendingPayment:\n`);

  for (const order of missingOrders) {
    const custName = order.customer?.firmName || order.customer?.name || "N/A";
    const amount = Number(order.commissionAmount || 0);
    console.log(
      `  • Order #${order.orderNo} (FY ${order.fyStartYear}-${order.fyStartYear + 1}) | User: ${order.user?.email} | Customer: ${custName} | Commission: ₹${amount.toLocaleString("en-IN")}`
    );

    if (flags.apply) {
      const created = await prisma.$transaction(async (tx) => {
        return createPendingPaymentForOrder(tx, order);
      });
      console.log(
        `    -> CREATED PendingPayment ID: ${created.id} (Serial #${created.serialNo}, Due: ₹${Number(created.amountDue).toLocaleString("en-IN")})`
      );
    }
  }

  console.log("-------------------------------------------------");
  if (!flags.apply) {
    console.log("Summary: Dry run complete. No database changes were made.");
    console.log("To apply changes, run with --apply:");
    console.log("  node scripts/repair-missing-pending-payments.js --apply");
    if (flags.email) {
      console.log(`  node scripts/repair-missing-pending-payments.js --apply --email ${flags.email}`);
    }
  } else {
    console.log(`Summary: Successfully repaired ${missingOrders.length} PendingPayment record(s).`);
  }
}

main()
  .catch((error) => {
    console.error("Execution failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

