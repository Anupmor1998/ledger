require("dotenv/config");

const prisma = require("../src/config/prisma");
const { getFinancialYearStartYear, getFinancialYearLabel } = require("../src/utils/financialYear");

const ORDER_STATUS = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
};

async function main() {
  const apply = process.argv.includes("--apply") || process.env.APPLY_REOPEN === "1";
  const targetFyStartYear = getFinancialYearStartYear(new Date());

  const completedOrders = await prisma.order.findMany({
    where: {
      fyStartYear: targetFyStartYear,
      status: ORDER_STATUS.COMPLETED,
    },
    select: {
      id: true,
      orderNo: true,
      quantity: true,
      quantityUnit: true,
      processedQuantity: true,
      processedMeter: true,
      status: true,
      customer: { select: { firmName: true, name: true } },
      manufacturer: { select: { firmName: true, name: true } },
      quality: { select: { name: true } },
      pendingPayment: {
        select: {
          id: true,
          paymentAllocations: {
            select: { id: true },
            take: 1,
          },
        },
      },
    },
    orderBy: [{ orderNo: "asc" }],
  });

  const report = {
    apply,
    targetFyStartYear,
    targetFyLabel: getFinancialYearLabel(targetFyStartYear),
    totalCompletedOrders: completedOrders.length,
    reopenableCount: 0,
    skippedDueToPayments: 0,
    skippedMissingPendingPayment: 0,
    sample: [],
  };

  const reopenableOrders = [];
  for (const order of completedOrders) {
    const hasPendingPayment = Boolean(order.pendingPayment);
    const hasAllocations = Boolean(order.pendingPayment?.paymentAllocations?.length);

    if (hasPendingPayment && hasAllocations) {
      report.skippedDueToPayments += 1;
      if (report.sample.length < 50) {
        report.sample.push({
          orderNo: order.orderNo,
          status: order.status,
          customer: order.customer?.firmName || order.customer?.name || "",
          manufacturer: order.manufacturer?.firmName || order.manufacturer?.name || "",
          quality: order.quality?.name || "",
          reason: "has payment allocations",
        });
      }
      continue;
    }

    reopenableOrders.push(order);
  }

  report.reopenableCount = reopenableOrders.length;

  if (apply) {
    for (const order of reopenableOrders) {
      await prisma.$transaction(async (tx) => {
        const currentOrder = await tx.order.findUnique({
          where: { id: order.id },
          select: {
            id: true,
            status: true,
            pendingPayment: {
              select: {
                id: true,
                paymentAllocations: {
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        });

        if (!currentOrder || currentOrder.status !== ORDER_STATUS.COMPLETED) {
          return;
        }

        if (currentOrder.pendingPayment?.paymentAllocations?.length) {
          return;
        }

        if (currentOrder.pendingPayment) {
          await tx.pendingPayment.delete({
            where: { id: currentOrder.pendingPayment.id },
          });
        }

        await tx.order.update({
          where: { id: currentOrder.id },
          data: { status: ORDER_STATUS.PENDING },
        });
      });
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
