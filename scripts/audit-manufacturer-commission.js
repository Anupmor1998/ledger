require("dotenv").config();
const prisma = require("../src/config/prisma");

async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, email: true },
  });

  for (const user of users) {
    const mfrs = await prisma.manufacturer.findMany({
      where: {
        userId: user.id,
        OR: [
          { commissionLotRate: { gt: 0 } },
          { commissionPercent: { gt: 0 } },
        ],
      },
      select: {
        id: true,
        firmName: true,
        name: true,
        commissionBase: true,
        commissionPercent: true,
        commissionLotRate: true,
      },
    });

    if (mfrs.length === 0) continue;

    console.log(`\n========================================`);
    console.log(`User: ${user.email} (${mfrs.length} mfrs configured)`);
    console.log(`========================================`);

    for (const m of mfrs) {
      const orders = await prisma.order.findMany({
        where: { manufacturerId: m.id, status: { not: "CANCELLED" } },
        select: {
          id: true,
          orderNo: true,
          fyStartYear: true,
          quantity: true,
          quantityUnit: true,
          lotMeters: true,
          rate: true,
          commissionAmount: true,
          manufacturerCommissionAmount: true,
          status: true,
        },
      });

      console.log(
        `\nMfr: "${m.firmName || m.name}" (ID: ${m.id}) | Base: ${m.commissionBase} | %: ${m.commissionPercent} | LotRate: ${m.commissionLotRate}`
      );
      console.log(`Orders found: ${orders.length}`);
      for (const o of orders) {
        console.log(
          `  - Order #${o.orderNo} (FY ${o.fyStartYear}): Qty=${o.quantity} ${o.quantityUnit}, Rate=${o.rate}, CustComm=${o.commissionAmount}, MfrComm=${o.manufacturerCommissionAmount}`
        );
      }
    }
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

