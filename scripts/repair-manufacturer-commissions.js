require("dotenv").config();

const prisma = require("../src/config/prisma");

const QUANTITY_UNITS = {
  TAKKA: "TAKKA",
  LOT: "LOT",
  METER: "METER",
};
const TAKKA_PER_LOT = 12;
const GST_RATE = 0.05;

function roundCurrency(value) {
  return Math.round(Number(value || 0));
}

function toLotQuantity({ quantity, quantityUnit, lotMeters }) {
  if (quantityUnit === QUANTITY_UNITS.LOT) {
    return quantity;
  }
  if (quantityUnit === QUANTITY_UNITS.TAKKA) {
    return quantity / TAKKA_PER_LOT;
  }
  const effectiveLotMeters = Number(lotMeters || 0) > 0 ? Number(lotMeters) : 1450;
  return quantity / effectiveLotMeters;
}

function toMeterFromQuantity({ quantity, quantityUnit, lotMeters }) {
  if (quantityUnit === QUANTITY_UNITS.METER) {
    return quantity;
  }
  const effectiveLotMeters = Number(lotMeters || 0) > 0 ? Number(lotMeters) : 1450;
  if (quantityUnit === QUANTITY_UNITS.LOT) {
    return quantity * effectiveLotMeters;
  }
  if (quantityUnit === QUANTITY_UNITS.TAKKA) {
    return (quantity / TAKKA_PER_LOT) * effectiveLotMeters;
  }
  return quantity;
}

function computeManufacturerCommissionAmount({
  quantityForCommission,
  rate,
  quantityUnit,
  lotMeters,
  manufacturerCommissionConfig,
}) {
  if (!Number.isFinite(quantityForCommission) || quantityForCommission <= 0) {
    return 0;
  }

  const commissionBase = String(
    manufacturerCommissionConfig?.commissionBase || "LOT"
  ).toUpperCase();
  const commissionPercent = Number(
    manufacturerCommissionConfig?.commissionPercent || 0
  );
  const commissionLotRate = Number(
    manufacturerCommissionConfig?.commissionLotRate || 0
  );

  if (commissionBase === "LOT") {
    if (commissionLotRate <= 0) {
      return 0;
    }
    const lotQuantity = toLotQuantity({
      quantity: quantityForCommission,
      quantityUnit,
      lotMeters,
    });
    return roundCurrency(lotQuantity * commissionLotRate);
  }

  if (commissionPercent <= 0) {
    return 0;
  }

  const meter = toMeterFromQuantity({
    quantity: quantityForCommission,
    quantityUnit,
    lotMeters,
  });
  const baseAmount = meter * rate;
  const gstAmount = baseAmount * GST_RATE;
  return roundCurrency((baseAmount + gstAmount) * (commissionPercent / 100));
}

function parseArgs(argv) {
  const args = {
    email: "",
    fy: null,
    apply: false,
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
    if (token === "--apply") {
      args.apply = true;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Mode: ${args.apply ? ">>> APPLY (Modifying Database) <<<" : "DRY RUN (Preview Only, use --apply to write)"}`);
  if (args.email) console.log(`Filter email: ${args.email}`);
  if (args.fy) console.log(`Filter FY: ${args.fy}`);

  const userWhere = args.email ? { email: args.email } : {};
  const users = await prisma.user.findMany({
    where: userWhere,
    select: { id: true, email: true },
  });

  let totalOrdersScanned = 0;
  let totalOrdersNeedingUpdate = 0;
  let totalOrdersUpdated = 0;

  for (const user of users) {
    const manufacturers = await prisma.manufacturer.findMany({
      where: {
        userId: user.id,
        OR: [
          { commissionLotRate: { gt: 0 } },
          { commissionPercent: { gt: 0 } },
        ],
      },
    });

    if (manufacturers.length === 0) continue;

    console.log(`\n======================================================`);
    console.log(`User: ${user.email} | ${manufacturers.length} manufacturers with commission`);
    console.log(`======================================================`);

    for (const mfr of manufacturers) {
      const orderWhere = {
        userId: user.id,
        manufacturerId: mfr.id,
        status: { not: "CANCELLED" },
        ...(args.fy ? { fyStartYear: args.fy } : {}),
      };

      const orders = await prisma.order.findMany({
        where: orderWhere,
        orderBy: [{ fyStartYear: "asc" }, { orderNo: "asc" }],
      });

      if (orders.length === 0) continue;

      console.log(`\nManufacturer: "${mfr.firmName || mfr.name}" (Base: ${mfr.commissionBase}, %: ${mfr.commissionPercent}, LotRate: ${mfr.commissionLotRate})`);

      for (const order of orders) {
        totalOrdersScanned += 1;
        const currentAmount = Number(order.manufacturerCommissionAmount ?? 0);
        const calculatedAmount = computeManufacturerCommissionAmount({
          quantityForCommission: Number(order.quantity || 0),
          rate: Number(order.rate || 0),
          quantityUnit: order.quantityUnit,
          lotMeters: order.lotMeters ? Number(order.lotMeters) : null,
          manufacturerCommissionConfig: mfr,
        });

        if (currentAmount !== calculatedAmount) {
          totalOrdersNeedingUpdate += 1;
          console.log(
            `  Order #${order.orderNo} (FY ${order.fyStartYear}): ` +
            `Qty=${order.quantity} ${order.quantityUnit}, Rate=${order.rate} | ` +
            `Current MfrComm: ₹${currentAmount} -> New MfrComm: ₹${calculatedAmount}`
          );

          if (args.apply) {
            await prisma.order.update({
              where: { id: order.id },
              data: {
                manufacturerCommissionAmount: calculatedAmount,
              },
            });
            totalOrdersUpdated += 1;
          }
        } else {
          console.log(
            `  Order #${order.orderNo} (FY ${order.fyStartYear}): Already up-to-date (₹${currentAmount})`
          );
        }
      }
    }
  }

  console.log(`\n======================================================`);
  console.log(`Summary:`);
  console.log(`Total orders scanned: ${totalOrdersScanned}`);
  console.log(`Total orders needing update: ${totalOrdersNeedingUpdate}`);
  console.log(`Total orders updated: ${totalOrdersUpdated}`);
  console.log(`======================================================\n`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

