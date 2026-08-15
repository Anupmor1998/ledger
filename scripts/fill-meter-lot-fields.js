require("dotenv").config();

const prisma = require("../src/config/prisma");

const QUANTITY_UNITS = {
  METER: "METER",
};

const LOT_MIN_METERS = 1450;
const LOT_MAX_METERS = 1550;

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
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
    quantityUnit: QUANTITY_UNITS.METER,
  };

  if (args.fy !== null) {
    where.fyStartYear = args.fy;
  }
  if (args.orderNo !== null) {
    where.orderNo = args.orderNo;
  }

  return where;
}

function getRandomLotMeters() {
  return LOT_MIN_METERS + Math.random() * (LOT_MAX_METERS - LOT_MIN_METERS);
}

function resolveLotMeters(order) {
  const existingLotMeters = Number(order.lotMeters);
  if (Number.isFinite(existingLotMeters) && existingLotMeters > 0) {
    return round2(existingLotMeters);
  }
  return round2(getRandomLotMeters());
}

function computeLotValue(quantity, lotMeters) {
  const resolvedQuantity = Number(quantity || 0);
  const resolvedLotMeters = Number(lotMeters || 0);

  if (!Number.isFinite(resolvedQuantity) || resolvedQuantity <= 0) {
    return null;
  }
  if (!Number.isFinite(resolvedLotMeters) || resolvedLotMeters <= 0) {
    return null;
  }

  return Math.round(resolvedQuantity / resolvedLotMeters);
}

function buildPreviewRow(order, nextLotMeters, nextLot) {
  return {
    userEmail: order.user.email,
    fyStartYear: order.fyStartYear,
    orderNo: order.orderNo,
    orderId: order.id,
    quantity: Number(order.quantity || 0),
    currentLotMeters: order.lotMeters === null || order.lotMeters === undefined ? null : Number(order.lotMeters),
    currentLot: order.lot === null || order.lot === undefined ? null : Number(order.lot),
    nextLotMeters,
    nextLot,
  };
}

async function applyRepair(orderId, nextLotMeters, nextLot) {
  await prisma.order.update({
    where: { id: orderId },
    data: {
      lotMeters: nextLotMeters,
      lot: nextLot,
    },
  });
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

  const affectedOrders = [];
  let totalScanned = 0;

  for (const user of users) {
    const orders = await prisma.order.findMany({
      where: buildOrderWhere(args, user.id),
      select: {
        id: true,
        fyStartYear: true,
        orderNo: true,
        quantity: true,
        quantityUnit: true,
        lotMeters: true,
        lot: true,
        user: { select: { email: true } },
      },
      orderBy: [{ fyStartYear: "desc" }, { orderNo: "desc" }],
    });

    totalScanned += orders.length;

    for (const order of orders) {
      const nextLotMeters = resolveLotMeters(order);
      const nextLot = computeLotValue(order.quantity, nextLotMeters);

      if (
        round2(Number(order.lotMeters || 0)) !== round2(nextLotMeters) ||
        Number(order.lot || 0) !== Number(nextLot || 0)
      ) {
        affectedOrders.push(buildPreviewRow(order, nextLotMeters, nextLot));
      }
    }
  }

  if (args.apply && affectedOrders.length) {
    for (const item of affectedOrders) {
      await applyRepair(item.orderId, item.nextLotMeters, item.nextLot);
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
      affectedOrders: affectedOrders.length,
      repairedOrders: args.apply ? affectedOrders.length : 0,
    },
    affectedOrders: affectedOrders.slice(0, args.limit),
    notes: [
      "This script targets only orders with quantityUnit = METER.",
      "If lotMeters is missing, a stable lot-meter basis is generated using the same range as the app.",
      "lot is stored as an integer using the resolved lotMeters basis.",
    ],
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Meter lot backfill (${result.mode})`);
  console.log("==============================");
  console.log(`Users scanned: ${result.scanned.users}`);
  console.log(`Orders scanned: ${result.scanned.orders}`);
  console.log(`Affected orders: ${result.summary.affectedOrders}`);
  if (args.apply) {
    console.log(`Orders repaired: ${result.summary.repairedOrders}`);
  }
  console.log("");

  if (affectedOrders.length) {
    console.log("Sample affected orders");
    console.log("----------------------");
    for (const item of affectedOrders.slice(0, args.limit)) {
      console.log(
        [
          item.userEmail,
          `FY ${item.fyStartYear}`,
          `Order ${item.orderNo}`,
          `quantity=${item.quantity}`,
          `lotMeters=${item.currentLotMeters ?? "null"} -> ${item.nextLotMeters}`,
          `lot=${item.currentLot ?? "null"} -> ${item.nextLot}`,
        ].join(" | ")
      );
    }
    console.log("");
  } else {
    console.log("No meter orders needed a lot/lotMeters backfill.");
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
      console.error("Meter lot backfill failed.");
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => {});
    });
}

module.exports = { run };
