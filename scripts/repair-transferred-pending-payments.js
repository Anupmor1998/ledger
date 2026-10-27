require('dotenv').config();
const prisma = require('../src/config/prisma');
const { syncPendingPaymentForOrder } = require('../src/controllers/orderController');

async function repair() {
  console.log('--- Checking for TRANSFERRED orders with missing PendingPayment ---');

  const transferredOrders = await prisma.order.findMany({
    where: {
      status: 'TRANSFERRED',
      commissionAmount: { gt: 0 },
    },
    include: {
      customer: true,
      pendingPayment: true,
    },
  });

  console.log(`Found ${transferredOrders.length} transferred order(s) with commission > 0.`);

  let createdCount = 0;
  for (const order of transferredOrders) {
    const processedQty = Number(order.processedQuantity || 0);
    const processedMtr = Number(order.processedMeter || 0);

    if (processedQty <= 0 && processedMtr <= 0) {
      console.log(`Order #${order.orderNo} (id: ${order.id}) has no processed deliveries. Skipping.`);
      continue;
    }

    if (order.pendingPayment) {
      console.log(`Order #${order.orderNo} (id: ${order.id}) already has PendingPayment #${order.pendingPayment.serialNo}. Skipping.`);
      continue;
    }

    console.log(`Order #${order.orderNo} (id: ${order.id}) has deliveries (${processedQty} qty, commission: ₹${order.commissionAmount}) but NO PendingPayment. Creating...`);

    const created = await prisma.$transaction(async (tx) => {
      return syncPendingPaymentForOrder(tx, order);
    });

    console.log(`-> Created PendingPayment id: ${created.id}, serialNo: ${created.serialNo}, balanceAmount: ₹${created.balanceAmount}`);
    createdCount += 1;
  }

  console.log(`\nCompleted repair. Total PendingPayment records created: ${createdCount}`);

  // Verification for moolchandvadera601@gmail.com
  const user = await prisma.user.findFirst({
    where: { email: 'moolchandvadera601@gmail.com' },
  });

  if (user) {
    const fy = 2026;
    const orders = await prisma.order.findMany({
      where: {
        userId: user.id,
        fyStartYear: fy,
      },
      select: {
        orderNo: true,
        status: true,
        commissionAmount: true,
        processedQuantity: true,
      },
    });

    const isEarned = (o) => {
      const st = String(o.status || '').toUpperCase();
      if (st === 'COMPLETED') return true;
      if (st === 'TRANSFERRED') {
        return Number(o.processedQuantity || 0) > 0 && Number(o.commissionAmount || 0) > 0;
      }
      return false;
    };

    const earnedOrders = orders.filter(isEarned);
    const totalEarnedCommission = earnedOrders.reduce((sum, o) => sum + Number(o.commissionAmount || 0), 0);

    const pendingSummary = await prisma.pendingPayment.aggregate({
      where: {
        userId: user.id,
        fyStartYear: fy,
        balanceAmount: { gt: 0 },
      },
      _sum: { balanceAmount: true },
    });

    const totalPendingCommission = Number(pendingSummary._sum.balanceAmount || 0);

    console.log('\n--- Verification for moolchandvadera601@gmail.com (FY 2026) ---');
    console.log(`Total Earned Commission: ₹${totalEarnedCommission}`);
    console.log(`Total Pending Commission: ₹${totalPendingCommission}`);
    console.log(`Difference: ₹${totalEarnedCommission - totalPendingCommission}`);
  }
}

repair()
  .catch((err) => {
    console.error('Repair error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });

