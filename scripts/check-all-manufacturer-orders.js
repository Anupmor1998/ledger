require("dotenv").config();
const prisma = require("../src/config/prisma");

async function checkAll() {
  const manufacturers = await prisma.manufacturer.findMany({
    include: {
      user: { select: { email: true } },
      orders: {
        where: { status: { not: "CANCELLED" } },
        select: {
          id: true,
          orderNo: true,
          fyStartYear: true,
          quantity: true,
          quantityUnit: true,
          rate: true,
          manufacturerCommissionAmount: true,
        },
      },
    },
  });

  const mfrsWithOrders = manufacturers.filter((m) => m.orders.length > 0);
  console.log(`Total manufacturers in DB: ${manufacturers.length}`);
  console.log(`Manufacturers with active orders: ${mfrsWithOrders.length}`);

  for (const m of mfrsWithOrders) {
    console.log(`\n==================================================`);
    console.log(`Manufacturer: "${m.firmName || m.name}" (ID: ${m.id})`);
    console.log(`User: ${m.user.email}`);
    console.log(`Settings: Base=${m.commissionBase}, Pct=${m.commissionPercent}, LotRate=${m.commissionLotRate}`);
    console.log(`Orders (${m.orders.length}):`);
    for (const o of m.orders) {
      console.log(`  - Order #${o.orderNo} (FY ${o.fyStartYear}): Qty=${o.quantity} ${o.quantityUnit}, Rate=${o.rate}, MfrCommission=₹${o.manufacturerCommissionAmount}`);
    }
  }
}

checkAll()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

