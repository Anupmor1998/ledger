require("dotenv").config();

const prisma = require("../src/config/prisma");
const { syncPendingPaymentAmounts, round2 } = require("../src/utils/payments");

function roundCurrency(value) {
  return Math.round(Number(value || 0));
}

function parseArgs(argv) {
  const args = {
    email: "",
    fy: null,
    orderNo: null,
    limit: 100,
    apply: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--email") {
      args.email = String(argv[index + 1] || "").trim().toLowerCase();
      index += 1;
      continue;
    }
    if (token === "--fy") {
      const fy = Number(argv[index + 1]);
      args.fy = Number.isInteger(fy) ? fy : null;
      index += 1;
      continue;
    }
    if (token === "--order-no") {
      const orderNo = Number(argv[index + 1]);
      args.orderNo = Number.isInteger(orderNo) ? orderNo : null;
      index += 1;
      continue;
    }
    if (token === "--limit") {
      const limit = Number(argv[index + 1]);
      args.limit = Number.isInteger(limit) && limit > 0 ? limit : args.limit;
      index += 1;
      continue;
    }
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
    }
  }

  return args;
}

function buildUserWhere(args) {
  if (!args.email) {
    return {};
  }
  return { email: args.email };
}

function buildOrderWhere(args, userId) {
  const where = {
    userId,
    commissionAmount: {
      not: null,
    },
  };

  if (args.fy !== null) {
    where.fyStartYear = args.fy;
  }
  if (args.orderNo !== null) {
    where.orderNo = args.orderNo;
  }

  return where;
}

function hasFractionalCurrency(value) {
  const number = Number(value || 0);
  return round2(number - roundCurrency(number)) !== 0;
}

function buildPreviewRow(order) {
  const currentCommission = Number(order.commissionAmount || 0);
  const roundedCommission = roundCurrency(currentCommission);
  const pendingAmountDue =
    order.pendingPayment?.amountDue === null || order.pendingPayment?.amountDue === undefined
      ? null
      : Number(order.pendingPayment.amountDue);

  return {
    userEmail: order.user.email,
    fyStartYear: order.fyStartYear,
    orderNo: order.orderNo,
    orderId: order.id,
    status: order.status,
    customer: order.customer?.firmName || order.customer?.name || "-",
    currentCommission,
    roundedCommission,
    diff: round2(roundedCommission - currentCommission),
    pendingPaymentId: order.pendingPayment?.id || null,
    pendingPaymentSerialNo: order.pendingPayment?.serialNo || null,
    pendingPaymentAmountDue: pendingAmountDue,
  };
}

async function repairOrder(tx, order) {
  const roundedCommission = roundCurrency(order.commissionAmount);

  await tx.order.update({
    where: { id: order.id },
    data: { commissionAmount: roundedCommission },
  });

  if (order.pendingPayment?.id) {
    await tx.pendingPayment.update({
      where: { id: order.pendingPayment.id },
      data: { amountDue: roundedCommission },
    });

    await syncPendingPaymentAmounts(tx, order.pendingPayment.id);
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const users = await prisma.user.findMany({
    where: buildUserWhere(args),
    select: { id: true, email: true },
    orderBy: { email: "asc" },
  });

  if (!users.length) {
    console.log("No matching users found.");
    return;
  }

  const candidates = [];

  for (const user of users) {
    const orders = await prisma.order.findMany({
      where: buildOrderWhere(args, user.id),
      include: {
        user: { select: { email: true } },
        customer: { select: { firmName: true, name: true } },
        pendingPayment: {
          select: {
            id: true,
            serialNo: true,
            amountDue: true,
          },
        },
      },
      orderBy: [{ fyStartYear: "desc" }, { orderNo: "desc" }],
    });

    for (const order of orders) {
      if (hasFractionalCurrency(order.commissionAmount)) {
        candidates.push(buildPreviewRow(order));
      }
    }
  }

  if (args.apply && candidates.length) {
    for (const candidate of candidates) {
      const order = await prisma.order.findUnique({
        where: { id: candidate.orderId },
        include: {
          pendingPayment: {
            select: {
              id: true,
            },
          },
        },
      });

      if (!order) {
        continue;
      }

      await prisma.$transaction(async (tx) => {
        await repairOrder(tx, order);
      });
    }
  }

  const result = {
    mode: args.apply ? "apply" : "dry-run",
    filters: {
      email: args.email || null,
      fyStartYear: args.fy,
      orderNo: args.orderNo,
    },
    summary: {
      affectedOrders: candidates.length,
    },
    affectedOrders: candidates.slice(0, args.limit),
    notes: [
      "This script only targets orders whose stored commissionAmount has a fractional currency value.",
      "On apply, order.commissionAmount is rounded to the nearest whole rupee.",
      "If the order has a linked pending payment, pendingPayment.amountDue is updated to the rounded commission and balances are resynced from existing allocations.",
    ],
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Commission rounding repair (${result.mode})`);
  console.log("=================================");
  console.log(`Affected orders: ${result.summary.affectedOrders}`);
  console.log("");

  if (candidates.length) {
    console.log("Sample affected orders");
    console.log("----------------------");
    for (const item of candidates.slice(0, args.limit)) {
      console.log(
        [
          item.userEmail,
          `FY ${item.fyStartYear}`,
          `Order ${item.orderNo}`,
          `current=${item.currentCommission}`,
          `rounded=${item.roundedCommission}`,
          `diff=${item.diff}`,
          item.pendingPaymentSerialNo ? `PP ${item.pendingPaymentSerialNo}` : "No pending payment",
        ].join(" | ")
      );
    }
    console.log("");
  } else {
    console.log("No orders with fractional commissionAmount found.");
    console.log("");
  }

  console.log("Notes");
  console.log("-----");
  for (const note of result.notes) {
    console.log(`- ${note}`);
  }
}

if (require.main === module) {
  run()
    .catch((error) => {
      console.error("Commission rounding repair failed.");
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => {});
    });
}

module.exports = { run };
