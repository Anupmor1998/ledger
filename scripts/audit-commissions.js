require("dotenv").config();

const prisma = require("../src/config/prisma");

const QUANTITY_UNITS = {
  TAKKA: "TAKKA",
  LOT: "LOT",
  METER: "METER",
};
const TAKKA_PER_LOT = 12;
const GST_RATE = 0.05;
const DEFAULT_COMMISSION_PERCENT = 1;

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function roundCurrency(value) {
  return Math.round(Number(value || 0));
}

function parseArgs(argv) {
  const args = {
    email: "",
    fy: null,
    orderNo: null,
    limit: 50,
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
    if (token === "--json") {
      args.json = true;
    }
  }

  return args;
}

function toMeterFromQuantity({ quantity, quantityUnit, lotMeters }) {
  const normalizedUnit = String(quantityUnit || "").toUpperCase();
  const normalizedQuantity = Number(quantity || 0);
  const normalizedLotMeters = Number(lotMeters || 0);

  if (normalizedUnit === QUANTITY_UNITS.METER) {
    return normalizedQuantity;
  }

  if (!Number.isFinite(normalizedLotMeters) || normalizedLotMeters <= 0) {
    return NaN;
  }

  if (normalizedUnit === QUANTITY_UNITS.LOT) {
    return normalizedQuantity * normalizedLotMeters;
  }

  return normalizedQuantity * (normalizedLotMeters / TAKKA_PER_LOT);
}

function computeExpectedCommission(order) {
  const quantity = Number(order?.quantity || 0);
  const rate = Number(order?.rate || 0);
  const commissionBase = String(order?.customer?.commissionBase || "PERCENT").toUpperCase();
  const commissionPercent =
    Number(order?.customer?.commissionPercent) > 0
      ? Number(order.customer.commissionPercent)
      : DEFAULT_COMMISSION_PERCENT;
  const commissionLotRate = Number(order?.customer?.commissionLotRate || 0);

  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(rate) || rate <= 0) {
    return 0;
  }

  if (commissionBase === "LOT") {
    return roundCurrency(quantity * commissionLotRate);
  }

  const meter = toMeterFromQuantity({
    quantity,
    quantityUnit: order.quantityUnit,
    lotMeters: order.lotMeters,
  });
  if (!Number.isFinite(meter) || meter <= 0) {
    return NaN;
  }

  const baseAmount = meter * rate;
  const gstAmount = baseAmount * GST_RATE;
  return roundCurrency((baseAmount + gstAmount) * (commissionPercent / 100));
}

function buildUserWhere(args) {
  if (!args.email) {
    return {};
  }
  return { email: args.email };
}

function buildOrderWhere(args, userId) {
  const where = { userId };
  if (args.fy !== null) {
    where.fyStartYear = args.fy;
  }
  if (args.orderNo !== null) {
    where.orderNo = args.orderNo;
  }
  return where;
}

function buildOrderMismatch(order, expectedCommission) {
  const storedCommission = Number(order.commissionAmount || 0);
  const diff = round2(storedCommission - expectedCommission);
  return {
    userEmail: order.user.email,
    fyStartYear: order.fyStartYear,
    orderNo: order.orderNo,
    orderId: order.id,
    status: order.status,
    customer: order.customer.firmName || order.customer.name || "-",
    quality: order.quality?.name || "-",
    quantity: Number(order.quantity || 0),
    quantityUnit: order.quantityUnit,
    lotMeters: order.lotMeters === null ? null : Number(order.lotMeters),
    rate: Number(order.rate || 0),
    storedCommission,
    expectedCommission,
    diff,
    currentCommissionBase: order.customer.commissionBase,
    currentCommissionPercent: Number(order.customer.commissionPercent || 0),
    currentCommissionLotRate:
      order.customer.commissionLotRate === null ? null : Number(order.customer.commissionLotRate),
    pendingPaymentAmountDue:
      order.pendingPayment?.amountDue === null || order.pendingPayment?.amountDue === undefined
        ? null
        : Number(order.pendingPayment.amountDue),
  };
}

function buildPendingPaymentMismatch(order) {
  const storedCommission = Number(order.commissionAmount || 0);
  const amountDue = Number(order.pendingPayment?.amountDue || 0);
  const diff = round2(amountDue - storedCommission);
  return {
    userEmail: order.user.email,
    fyStartYear: order.fyStartYear,
    orderNo: order.orderNo,
    orderId: order.id,
    pendingPaymentId: order.pendingPayment.id,
    pendingPaymentSerialNo: order.pendingPayment.serialNo,
    status: order.status,
    customer: order.customer.firmName || order.customer.name || "-",
    storedCommission,
    pendingPaymentAmountDue: amountDue,
    diff,
  };
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

  const orderMismatches = [];
  const pendingPaymentMismatches = [];
  let totalOrdersScanned = 0;

  for (const user of users) {
    const orders = await prisma.order.findMany({
      where: buildOrderWhere(args, user.id),
      include: {
        user: { select: { email: true } },
        customer: {
          select: {
            firmName: true,
            name: true,
            commissionBase: true,
            commissionPercent: true,
            commissionLotRate: true,
          },
        },
        quality: { select: { name: true } },
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

    totalOrdersScanned += orders.length;

    for (const order of orders) {
      const expectedCommission = computeExpectedCommission(order);
      const storedCommission = Number(order.commissionAmount || 0);

      if (Number.isFinite(expectedCommission) && round2(storedCommission - expectedCommission) !== 0) {
        orderMismatches.push(buildOrderMismatch(order, expectedCommission));
      }

      if (order.pendingPayment) {
        const amountDue = Number(order.pendingPayment.amountDue || 0);
        if (round2(amountDue - storedCommission) !== 0) {
          pendingPaymentMismatches.push(buildPendingPaymentMismatch(order));
        }
      }
    }
  }

  const result = {
    filters: {
      email: args.email || null,
      fyStartYear: args.fy,
      orderNo: args.orderNo,
    },
    scanned: {
      users: users.length,
      orders: totalOrdersScanned,
    },
    summary: {
      orderCommissionMismatches: orderMismatches.length,
      pendingPaymentMismatches: pendingPaymentMismatches.length,
    },
    orderCommissionMismatches: orderMismatches.slice(0, args.limit),
    pendingPaymentMismatches: pendingPaymentMismatches.slice(0, args.limit),
    notes: [
      "This script is read-only.",
      "Order commission mismatch uses the current customer commission config for recomputation.",
      "If customer commission settings were changed after order creation, a reported mismatch may reflect historical master-data drift rather than DB corruption.",
      "Pending payment mismatch compares pendingPayment.amountDue with the order's stored commissionAmount.",
    ],
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("Commission audit summary");
  console.log("========================");
  console.log(`Users scanned: ${result.scanned.users}`);
  console.log(`Orders scanned: ${result.scanned.orders}`);
  console.log(`Order commission mismatches: ${result.summary.orderCommissionMismatches}`);
  console.log(`Pending payment mismatches: ${result.summary.pendingPaymentMismatches}`);
  console.log("");

  if (orderMismatches.length) {
    console.log("Order commission mismatches");
    console.log("---------------------------");
    for (const item of orderMismatches.slice(0, args.limit)) {
      console.log(
        [
          `${item.userEmail}`,
          `FY ${item.fyStartYear}`,
          `Order ${item.orderNo}`,
          `${item.customer}`,
          `stored=${item.storedCommission}`,
          `expected=${item.expectedCommission}`,
          `diff=${item.diff}`,
          `base=${item.currentCommissionBase}`,
        ].join(" | ")
      );
    }
    console.log("");
  }

  if (pendingPaymentMismatches.length) {
    console.log("Pending payment mismatches");
    console.log("--------------------------");
    for (const item of pendingPaymentMismatches.slice(0, args.limit)) {
      console.log(
        [
          `${item.userEmail}`,
          `FY ${item.fyStartYear}`,
          `Order ${item.orderNo}`,
          `PP ${item.pendingPaymentSerialNo}`,
          `commission=${item.storedCommission}`,
          `amountDue=${item.pendingPaymentAmountDue}`,
          `diff=${item.diff}`,
        ].join(" | ")
      );
    }
    console.log("");
  }

  if (!orderMismatches.length && !pendingPaymentMismatches.length) {
    console.log("No mismatches found for the selected scope.");
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
      console.error("Commission audit failed.");
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => {});
    });
}

module.exports = { run };
