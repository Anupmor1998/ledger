require("dotenv").config();

const prisma = require("../src/config/prisma");
const { syncPendingPaymentAmounts } = require("../src/utils/payments");

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

function toLotQuantity({ quantity, quantityUnit, lotMeters }) {
  const normalizedUnit = String(quantityUnit || "").toUpperCase();
  const normalizedQuantity = Number(quantity || 0);
  const normalizedLotMeters = Number(lotMeters || 0);

  if (normalizedUnit === QUANTITY_UNITS.LOT) {
    return normalizedQuantity;
  }

  if (normalizedUnit === QUANTITY_UNITS.METER) {
    if (!Number.isFinite(normalizedLotMeters) || normalizedLotMeters <= 0) {
      return NaN;
    }
    return normalizedQuantity / normalizedLotMeters;
  }

  if (!Number.isFinite(normalizedLotMeters) || normalizedLotMeters <= 0) {
    return NaN;
  }

  return normalizedQuantity / TAKKA_PER_LOT;
}

function computeCommissionAmount({
  quantityForCommission,
  rate,
  quantityUnit,
  lotMeters,
  customerCommissionConfig,
}) {
  if (!Number.isFinite(quantityForCommission) || quantityForCommission <= 0) {
    return 0;
  }

  const commissionBase = String(customerCommissionConfig?.commissionBase || "PERCENT").toUpperCase();
  const commissionPercent =
    Number(customerCommissionConfig?.commissionPercent) > 0
      ? Number(customerCommissionConfig.commissionPercent)
      : DEFAULT_COMMISSION_PERCENT;
  const commissionLotRate = Number(customerCommissionConfig?.commissionLotRate || 0);

  if (commissionBase === "LOT") {
    const lotQuantity = toLotQuantity({
      quantity: quantityForCommission,
      quantityUnit,
      lotMeters,
    });
    return roundCurrency(lotQuantity * commissionLotRate);
  }

  const meter = toMeterFromQuantity({
    quantity: quantityForCommission,
    quantityUnit,
    lotMeters,
  });
  if (!Number.isFinite(meter) || meter <= 0) {
    return 0;
  }

  const baseAmount = meter * rate;
  const gstAmount = baseAmount * GST_RATE;
  return roundCurrency((baseAmount + gstAmount) * (commissionPercent / 100));
}

function computeLiveProgressCommissionAmount(order) {
  const quantity = Number(order?.quantity || 0);
  const rate = Number(order?.rate || 0);
  const lotMeters = order?.lotMeters === null || order?.lotMeters === undefined ? null : Number(order.lotMeters);
  const commissionConfig = order?.customer || null;
  const fullCommissionAmount = computeCommissionAmount({
    quantityForCommission: quantity,
    rate,
    quantityUnit: order?.quantityUnit,
    lotMeters,
    customerCommissionConfig: commissionConfig,
  });

  const processedMeter = Number(order?.processedMeter || 0);
  const totalMeter = Number(order?.meter || 0);
  if (
    Number.isFinite(processedMeter) &&
    Number.isFinite(totalMeter) &&
    totalMeter > 0
  ) {
    return roundCurrency((fullCommissionAmount * processedMeter) / totalMeter);
  }

  if (Number.isFinite(quantity) && quantity > 0) {
    const processedQuantity = Number(order?.processedQuantity || 0);
    return roundCurrency((fullCommissionAmount * processedQuantity) / quantity);
  }

  return roundCurrency(fullCommissionAmount);
}

function buildPreviewRow(order, expectedCommission) {
  const storedCommission = roundCurrency(order.commissionAmount);
  const processedMeter = Number(order.processedMeter || 0);
  const processedQuantity = Number(order.processedQuantity || 0);

  return {
    userEmail: order.user.email,
    fyStartYear: order.fyStartYear,
    orderNo: order.orderNo,
    orderId: order.id,
    status: order.status,
    customer: order.customer?.firmName || order.customer?.name || "-",
    processedMeter,
    processedQuantity,
    meter: order.meter === null || order.meter === undefined ? null : Number(order.meter),
    storedCommission,
    expectedCommission,
    diff: round2(storedCommission - expectedCommission),
    pendingPaymentId: order.pendingPayment?.id || null,
    pendingPaymentSerialNo: order.pendingPayment?.serialNo || null,
    pendingPaymentAmountDue:
      order.pendingPayment?.amountDue === null || order.pendingPayment?.amountDue === undefined
        ? null
        : Number(order.pendingPayment.amountDue),
  };
}

async function repairOrder(tx, order) {
  const expectedCommission = computeLiveProgressCommissionAmount(order);
  const storedCommission = roundCurrency(order.commissionAmount);

  if (storedCommission !== expectedCommission) {
    await tx.order.update({
      where: { id: order.id },
      data: { commissionAmount: expectedCommission },
    });
  }

  if (order.pendingPayment?.id) {
    await tx.pendingPayment.update({
      where: { id: order.pendingPayment.id },
      data: { amountDue: expectedCommission },
    });
    await syncPendingPaymentAmounts(tx, order.pendingPayment.id);
  }

  return {
    storedCommission,
    expectedCommission,
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

  const mismatches = [];
  let totalScanned = 0;

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

    totalScanned += orders.length;

    for (const order of orders) {
      const expectedCommission = computeLiveProgressCommissionAmount(order);
      const storedCommission = roundCurrency(order.commissionAmount);
      if (storedCommission !== expectedCommission) {
        mismatches.push(buildPreviewRow(order, expectedCommission));
      }
    }
  }

  if (args.apply && mismatches.length) {
    for (const item of mismatches) {
      const latestOrder = await prisma.order.findUnique({
        where: { id: item.orderId },
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
          pendingPayment: {
            select: {
              id: true,
            },
          },
        },
      });

      if (!latestOrder) {
        continue;
      }

      await prisma.$transaction(async (tx) => {
        await repairOrder(tx, latestOrder);
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
    scanned: {
      users: users.length,
      orders: totalScanned,
    },
    summary: {
      commissionMismatches: mismatches.length,
      repairedOrders: args.apply ? mismatches.length : 0,
    },
    commissionMismatches: mismatches.slice(0, args.limit),
    notes: [
      "This script compares stored order.commissionAmount against the live commission preview formula used by the app.",
      "On apply, it updates order.commissionAmount and any linked pendingPayment.amountDue to the recomputed live value.",
      "If the order's processedMeter is missing, the same live fallback logic used by the app is applied.",
    ],
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Live commission repair (${result.mode})`);
  console.log("==================================");
  console.log(`Users scanned: ${result.scanned.users}`);
  console.log(`Orders scanned: ${result.scanned.orders}`);
  console.log(`Commission mismatches: ${result.summary.commissionMismatches}`);
  if (args.apply) {
    console.log(`Orders repaired: ${result.summary.repairedOrders}`);
  }
  console.log("");

  if (mismatches.length) {
    console.log("Sample mismatches");
    console.log("-----------------");
    for (const item of mismatches.slice(0, args.limit)) {
      console.log(
        [
          item.userEmail,
          `FY ${item.fyStartYear}`,
          `Order ${item.orderNo}`,
          item.customer,
          `processedMeter=${item.processedMeter}`,
          `stored=${item.storedCommission}`,
          `expected=${item.expectedCommission}`,
          `diff=${item.diff}`,
        ].join(" | ")
      );
    }
    console.log("");
  } else {
    console.log("No commission mismatches found for the selected scope.");
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
      console.error("Live commission repair failed.");
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => {});
    });
}

module.exports = { run };
