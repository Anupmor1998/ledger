const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const {
  round2,
  roundCurrency,
  safeNumber,
  formatCellDate,
  computeLotValue,
  computeMeterValue,
  computeOrderFullCommission,
  getSelectedFinancialYearStartForUser,
  getNextPaymentEntrySerialNo,
  isPaymentEntrySerialConflict,
} = require("../utils/paymentEntries");
const { getFinancialYearStartYear } = require("../utils/financialYear");

const PAYMENT_ENTRY_RETRY_LIMIT = 5;

const getNextSerialNo = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const fyStartYear = req.query.fyStartYear
    ? Number(req.query.fyStartYear)
    : await getSelectedFinancialYearStartForUser(userId);

  const serialNo = await getNextPaymentEntrySerialNo(
    prisma,
    userId,
    fyStartYear,
  );

  return res.json({
    serialNo,
    fyStartYear,
  });
});

const getEligibleOrders = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { customerId, from, to } = req.query;

  if (!customerId) {
    throw new AppError("customerId is required", 400);
  }
  if (!from || !to) {
    throw new AppError("from and to date range are required", 400);
  }

  const fromDate = new Date(from);
  fromDate.setHours(0, 0, 0, 0);
  const toDate = new Date(to);
  toDate.setHours(23, 59, 59, 999);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new AppError("Invalid date range provided", 400);
  }

  const orders = await prisma.order.findMany({
    where: {
      userId,
      customerId,
      status: { not: "CANCELLED" },
      orderDate: {
        gte: fromDate,
        lte: toDate,
      },
    },
    include: {
      customer: true,
      manufacturer: true,
      quality: true,
      paymentOrderAllocations: {
        select: {
          allocatedAmount: true,
          isSettled: true,
        },
      },
    },
    orderBy: [{ orderDate: "asc" }, { orderNo: "asc" }],
  });

  const formattedOrders = orders.map((order) => {
    const commissionAmount = computeOrderFullCommission(order, order.customer);
    const totalAllocated = round2(
      order.paymentOrderAllocations.reduce(
        (sum, alloc) => sum + Number(alloc.allocatedAmount || 0),
        0,
      ),
    );
    const isSettled =
      order.paymentOrderAllocations.some((alloc) => alloc.isSettled) ||
      (commissionAmount > 0 && totalAllocated >= commissionAmount);
    const remainingAmount = isSettled
      ? 0
      : Math.max(0, round2(commissionAmount - totalAllocated));

    return {
      id: order.id,
      orderId: order.orderNo,
      orderNo: order.orderNo,
      amount: commissionAmount,
      commissionAmount,
      allocatedAmount: totalAllocated,
      remainingAmount,
      isSettled,
      lot: computeLotValue(order),
      quality: order.quality?.name || "",
      meter: computeMeterValue(order).toFixed(2),
      rate: round2(order.rate).toFixed(2),
      date: formatCellDate(order.orderDate),
      rawDate: order.orderDate,
      partyFirmName: order.manufacturer?.firmName || "",
      partyName: order.manufacturer?.name || "",
      customerFirmName: order.customer?.firmName || "",
      customerName: order.customer?.name || "",
    };
  });

  const includeSettled = req.query.includeSettled === "true";
  const result = includeSettled
    ? formattedOrders
    : formattedOrders.filter(
        (order) => !order.isSettled && order.remainingAmount > 0,
      );

  return res.json({
    orders: result,
    totalCount: result.length,
    totalRemainingCommission: round2(
      result.reduce((sum, o) => sum + o.remainingAmount, 0),
    ),
  });
});

const createPaymentEntry = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const partyType = String(req.body.partyType || "CUSTOMER").toUpperCase();
  const isManufacturer = partyType === "MANUFACTURER";

  const {
    customerId,
    manufacturerId,
    date,
    paymentMode,
    amount,
    remark,
    adjustedAgainst = "ORDER_ID",
    orderDateFrom,
    orderDateTo,
    selectedOrderIds = [],
  } = req.body;

  if (isManufacturer) {
    if (!manufacturerId) {
      throw new AppError("Manufacturer is required", 400);
    }
    const manufacturer = await prisma.manufacturer.findFirst({
      where: { id: manufacturerId, userId },
    });
    if (!manufacturer) {
      throw new AppError("Manufacturer not found", 404);
    }
  } else {
    if (!customerId) {
      throw new AppError("Customer is required", 400);
    }
  }

  if (!date) {
    throw new AppError("Payment date is required", 400);
  }
  if (!paymentMode) {
    throw new AppError("Payment mode is required", 400);
  }
  const numericAmount = round2(amount);
  if (numericAmount <= 0) {
    throw new AppError("Amount must be greater than 0", 400);
  }

  const validModes = ["CASH", "CHEQUE", "ONLINE", "UPI"];
  if (!validModes.includes(paymentMode)) {
    throw new AppError(
      `Payment mode must be one of: ${validModes.join(", ")}`,
      400,
    );
  }

  const paymentDate = new Date(date);
  if (Number.isNaN(paymentDate.getTime())) {
    throw new AppError("Invalid payment date", 400);
  }

  const fyStartYear = await getSelectedFinancialYearStartForUser(userId);

  // If manufacturer, record on-account payment directly
  if (isManufacturer) {
    const paymentEntry = await prisma.$transaction(async (tx) => {
      let created = null;

      for (let attempt = 0; attempt < PAYMENT_ENTRY_RETRY_LIMIT; attempt += 1) {
        try {
          const serialNo = await getNextPaymentEntrySerialNo(
            tx,
            userId,
            fyStartYear,
          );

          created = await tx.paymentEntry.create({
            data: {
              userId,
              fyStartYear,
              serialNo,
              partyType: "MANUFACTURER",
              manufacturerId,
              customerId: null,
              date: paymentDate,
              paymentMode,
              remark: remark ? String(remark).trim() : null,
              amount: numericAmount,
              adjustedAgainst: "PARTIAL",
              orderDateFrom: null,
              orderDateTo: null,
              isFullySettled: false,
            },
          });
          break;
        } catch (error) {
          if (
            isPaymentEntrySerialConflict(error) &&
            attempt < PAYMENT_ENTRY_RETRY_LIMIT - 1
          ) {
            continue;
          }
          throw error;
        }
      }

      if (!created) {
        throw new AppError(
          "Failed to assign a unique serial number for this payment",
          500,
        );
      }

      return created;
    });

    const fullRecord = await prisma.paymentEntry.findUnique({
      where: { id: paymentEntry.id },
      include: {
        manufacturer: {
          select: { id: true, firmName: true, name: true, phone: true },
        },
        allocations: true,
      },
    });

    return res.status(201).json(fullRecord);
  }

  let ordersToAllocate = [];
  if (adjustedAgainst === "ORDER_ID") {
    if (!Array.isArray(selectedOrderIds) || selectedOrderIds.length === 0) {
      throw new AppError(
        "At least one order must be selected for ORDER_ID adjustment",
        400,
      );
    }

    ordersToAllocate = await prisma.order.findMany({
      where: {
        id: { in: selectedOrderIds },
        userId,
        customerId,
        status: { not: "CANCELLED" },
      },
      include: {
        customer: true,
        paymentOrderAllocations: {
          select: {
            allocatedAmount: true,
            isSettled: true,
          },
        },
      },
      orderBy: [{ orderDate: "asc" }, { orderNo: "asc" }],
    });

    if (ordersToAllocate.length !== selectedOrderIds.length) {
      throw new AppError(
        "One or more selected orders are invalid or do not belong to this customer",
        400,
      );
    }

    const alreadySettledOrder = ordersToAllocate.find((ord) =>
      ord.paymentOrderAllocations.some((alloc) => alloc.isSettled),
    );
    if (alreadySettledOrder) {
      throw new AppError(
        `Order #${alreadySettledOrder.orderNo} is already settled. You cannot record another payment against an already settled order.`,
        400,
      );
    }
  }

  let fromDate = null;
  let toDate = null;
  if (orderDateFrom) {
    fromDate = new Date(orderDateFrom);
    if (Number.isNaN(fromDate.getTime())) fromDate = null;
    else fromDate.setHours(0, 0, 0, 0);
  }
  if (orderDateTo) {
    toDate = new Date(orderDateTo);
    if (Number.isNaN(toDate.getTime())) toDate = null;
    else toDate.setHours(23, 59, 59, 999);
  }

  if (fromDate && toDate && fromDate > toDate) {
    throw new AppError("From date cannot be after To date", 400);
  }

  if (adjustedAgainst === "PARTIAL" && fromDate && toDate) {
    const existingSettled = await prisma.paymentEntry.findFirst({
      where: {
        userId,
        customerId,
        isFullySettled: true,
        orderDateFrom: { lte: toDate },
        orderDateTo: { gte: fromDate },
      },
      select: {
        serialNo: true,
        orderDateFrom: true,
        orderDateTo: true,
      },
    });

    if (existingSettled) {
      const settledRange = `${formatCellDate(existingSettled.orderDateFrom)} to ${formatCellDate(existingSettled.orderDateTo)}`;
      throw new AppError(
        `Customer account for the period (${settledRange}) has already been marked as Fully Settled (Entry #${existingSettled.serialNo}). No duplicate or additional payments can be recorded for this settled period.`,
        400,
      );
    }

    // Check if all actual orders for this customer in this date range are already settled
    const ordersInRange = await prisma.order.findMany({
      where: {
        userId,
        customerId,
        status: { not: "CANCELLED" },
        orderDate: {
          gte: fromDate,
          lte: toDate,
        },
      },
      include: {
        customer: true,
        paymentOrderAllocations: {
          select: {
            allocatedAmount: true,
            isSettled: true,
          },
        },
      },
    });

    if (ordersInRange.length > 0) {
      const unsettledOrders = ordersInRange.filter((ord) => {
        const commissionAmount = computeOrderFullCommission(ord, ord.customer);
        const totalAllocated = ord.paymentOrderAllocations.reduce(
          (sum, alloc) => sum + Number(alloc.allocatedAmount || 0),
          0,
        );
        const isSettled =
          ord.paymentOrderAllocations.some((alloc) => alloc.isSettled) ||
          (commissionAmount > 0 && totalAllocated >= commissionAmount);
        return !isSettled;
      });

      if (unsettledOrders.length === 0) {
        throw new AppError(
          `All orders for this customer in the date range (${formatCellDate(fromDate)} to ${formatCellDate(toDate)}) are already settled. No additional payments can be recorded for this period.`,
          400,
        );
      }
    }
  }

  const paymentEntry = await prisma.$transaction(async (tx) => {
    let created = null;

    for (let attempt = 0; attempt < PAYMENT_ENTRY_RETRY_LIMIT; attempt += 1) {
      try {
        const serialNo = await getNextPaymentEntrySerialNo(
          tx,
          userId,
          fyStartYear,
        );

        created = await tx.paymentEntry.create({
          data: {
            userId,
            fyStartYear,
            serialNo,
            customerId,
            date: paymentDate,
            paymentMode,
            remark: remark ? String(remark).trim() : null,
            amount: numericAmount,
            adjustedAgainst,
            orderDateFrom: fromDate,
            orderDateTo: toDate,
            isFullySettled: false,
          },
        });
        break;
      } catch (error) {
        if (
          isPaymentEntrySerialConflict(error) &&
          attempt < PAYMENT_ENTRY_RETRY_LIMIT - 1
        ) {
          continue;
        }
        throw error;
      }
    }

    if (!created) {
      throw new AppError(
        "Failed to assign a unique serial number for this payment",
        500,
      );
    }

    // Allocate sequentially if ORDER_ID
    if (adjustedAgainst === "ORDER_ID" && ordersToAllocate.length > 0) {
      let remainingPayment = numericAmount;
      let allSettled = true;

      for (let i = 0; i < ordersToAllocate.length; i += 1) {
        const ord = ordersToAllocate[i];
        const isLastOrder = i === ordersToAllocate.length - 1;

        const commissionAmount = computeOrderFullCommission(ord, ord.customer);
        const prevAllocated = round2(
          ord.paymentOrderAllocations.reduce(
            (sum, alloc) => sum + Number(alloc.allocatedAmount || 0),
            0,
          ),
        );
        const remainingDue = Math.max(
          0,
          round2(commissionAmount - prevAllocated),
        );

        if (remainingPayment <= 0 && !isLastOrder) {
          allSettled = false;
          break;
        }

        let allocationForThisOrder = isLastOrder
          ? round2(remainingPayment)
          : round2(Math.min(remainingPayment, remainingDue));

        if (allocationForThisOrder > 0) {
          const totalAfter = round2(prevAllocated + allocationForThisOrder);
          const isSettled = isLastOrder || totalAfter >= commissionAmount;
          if (!isSettled) {
            allSettled = false;
          }

          await tx.paymentOrderAllocation.create({
            data: {
              userId,
              paymentEntryId: created.id,
              orderId: ord.id,
              allocatedAmount: allocationForThisOrder,
              isSettled,
            },
          });

          remainingPayment = round2(
            Math.max(0, remainingPayment - allocationForThisOrder),
          );
        }
      }

      if (allSettled) {
        created = await tx.paymentEntry.update({
          where: { id: created.id },
          data: {
            isFullySettled: true,
            finalSettledAmount: numericAmount,
            settledAt: new Date(),
          },
        });
      }
    }

    return created;
  });

  const fullRecord = await prisma.paymentEntry.findUnique({
    where: { id: paymentEntry.id },
    include: {
      customer: {
        select: { id: true, firmName: true, name: true, phone: true },
      },
      allocations: {
        include: {
          order: {
            select: {
              id: true,
              orderNo: true,
              commissionAmount: true,
              orderDate: true,
            },
          },
        },
      },
    },
  });

  return res.status(201).json(fullRecord);
});

const listPaymentEntries = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const skip = (page - 1) * limit;

  const fyStartYear = req.query.fyStartYear
    ? Number(req.query.fyStartYear)
    : await getSelectedFinancialYearStartForUser(userId);

  const where = {
    userId,
    fyStartYear,
  };

  if (req.query.partyType) {
    where.partyType = String(req.query.partyType).toUpperCase();
  }

  if (req.query.customerId) {
    where.customerId = req.query.customerId;
  }

  if (req.query.manufacturerId) {
    where.manufacturerId = req.query.manufacturerId;
  }

  if (req.query.paymentMode) {
    where.paymentMode = req.query.paymentMode;
  }

  if (req.query.adjustedAgainst) {
    where.adjustedAgainst = req.query.adjustedAgainst;
  }

  if (
    req.query.isFullySettled !== undefined &&
    req.query.isFullySettled !== ""
  ) {
    where.isFullySettled = req.query.isFullySettled === "true";
  }

  if (req.query.from || req.query.to) {
    where.date = {};
    if (req.query.from) {
      const from = new Date(req.query.from);
      from.setHours(0, 0, 0, 0);
      where.date.gte = from;
    }
    if (req.query.to) {
      const to = new Date(req.query.to);
      to.setHours(23, 59, 59, 999);
      where.date.lte = to;
    }
  }

  if (req.query.search) {
    const search = String(req.query.search).trim();
    const isNum = !Number.isNaN(Number(search));

    where.OR = [
      { customer: { firmName: { contains: search, mode: "insensitive" } } },
      { customer: { name: { contains: search, mode: "insensitive" } } },
      { manufacturer: { firmName: { contains: search, mode: "insensitive" } } },
      { manufacturer: { name: { contains: search, mode: "insensitive" } } },
      { remark: { contains: search, mode: "insensitive" } },
    ];
    if (isNum) {
      where.OR.push({ serialNo: Number(search) });
    }
  }

  const [entries, totalCount, aggregate] = await Promise.all([
    prisma.paymentEntry.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ date: "desc" }, { serialNo: "desc" }],
      include: {
        customer: {
          select: { id: true, firmName: true, name: true, phone: true },
        },
        manufacturer: {
          select: { id: true, firmName: true, name: true, phone: true },
        },
        allocations: {
          include: {
            order: {
              select: {
                id: true,
                orderNo: true,
                commissionAmount: true,
                orderDate: true,
                manufacturer: {
                  select: { firmName: true, name: true },
                },
              },
            },
          },
        },
        _count: {
          select: { allocations: true },
        },
      },
    }),
    prisma.paymentEntry.count({ where }),
    prisma.paymentEntry.aggregate({
      where,
      _sum: {
        amount: true,
        finalSettledAmount: true,
      },
    }),
  ]);

  return res.json({
    data: entries,
    pagination: {
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit) || 1,
    },
    aggregates: {
      totalAmount: round2(aggregate._sum.amount || 0),
      totalFinalSettledAmount: round2(aggregate._sum.finalSettledAmount || 0),
    },
  });
});

const getPaymentEntryById = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  const entry = await prisma.paymentEntry.findFirst({
    where: { id, userId },
    include: {
      customer: true,
      manufacturer: true,
      allocations: {
        include: {
          order: {
            include: {
              manufacturer: true,
              quality: true,
            },
          },
        },
      },
    },
  });

  if (!entry) {
    throw new AppError("Payment entry not found", 404);
  }

  return res.json(entry);
});

const settlePartialAccount = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const { finalSettledAmount } = req.body;

  const entry = await prisma.paymentEntry.findFirst({
    where: { id, userId },
    include: {
      customer: true,
      manufacturer: true,
    },
  });

  if (!entry) {
    throw new AppError("Payment entry not found", 404);
  }

  if (entry.adjustedAgainst !== "PARTIAL") {
    throw new AppError(
      "Only partial payment entries can be settled via account settlement",
      400,
    );
  }

  if (entry.isFullySettled) {
    throw new AppError("This payment entry is already fully settled", 400);
  }

  const numericFinalAmount =
    finalSettledAmount !== undefined &&
    finalSettledAmount !== null &&
    finalSettledAmount !== ""
      ? round2(finalSettledAmount)
      : round2(entry.amount);

  if (numericFinalAmount < 0) {
    throw new AppError("Final settled amount cannot be negative", 400);
  }

  if (entry.partyType === "MANUFACTURER") {
    const updatedEntry = await prisma.paymentEntry.update({
      where: { id: entry.id },
      data: {
        amount: numericFinalAmount,
        isFullySettled: true,
        finalSettledAmount: numericFinalAmount,
        settledAt: new Date(),
      },
    });

    return res.json({
      message: "Manufacturer payment entry marked as settled successfully",
      entry: updatedEntry,
    });
  }

  if (!entry.customerId) {
    throw new AppError("Customer ID is missing for customer payment entry", 400);
  }

  const orderWhere = {
    userId,
    customerId: entry.customerId,
    status: { not: "CANCELLED" },
  };

  if (entry.orderDateFrom || entry.orderDateTo) {
    orderWhere.orderDate = {};
    if (entry.orderDateFrom) {
      orderWhere.orderDate.gte = entry.orderDateFrom;
    }
    if (entry.orderDateTo) {
      orderWhere.orderDate.lte = entry.orderDateTo;
    }
  }

  const customerOrders = await prisma.order.findMany({
    where: orderWhere,
    include: {
      customer: true,
      paymentOrderAllocations: {
        select: {
          paymentEntryId: true,
          allocatedAmount: true,
          isSettled: true,
        },
      },
    },
    orderBy: [{ orderDate: "asc" }, { orderNo: "asc" }],
  });

  const updatedEntry = await prisma.$transaction(async (tx) => {
    const updated = await tx.paymentEntry.update({
      where: { id: entry.id },
      data: {
        amount: numericFinalAmount,
        isFullySettled: true,
        finalSettledAmount: numericFinalAmount,
        settledAt: new Date(),
      },
    });

    // Remove any previous allocations for this payment entry if re-settling
    await tx.paymentOrderAllocation.deleteMany({
      where: { paymentEntryId: entry.id },
    });

    const ordersToSettle = customerOrders.filter((ord) => {
      const settledByOther = ord.paymentOrderAllocations.some(
        (alloc) => alloc.isSettled && alloc.paymentEntryId !== entry.id,
      );
      return !settledByOther;
    });

    let remainingPayment = numericFinalAmount;

    for (let i = 0; i < ordersToSettle.length; i += 1) {
      const ord = ordersToSettle[i];
      const isLastOrder = i === ordersToSettle.length - 1;

      const commissionAmount = computeOrderFullCommission(ord, ord.customer);
      const prevAllocated = round2(
        ord.paymentOrderAllocations
          .filter((alloc) => alloc.paymentEntryId !== entry.id)
          .reduce((sum, alloc) => sum + Number(alloc.allocatedAmount || 0), 0),
      );
      const remainingDue = Math.max(
        0,
        round2(commissionAmount - prevAllocated),
      );

      let allocationForThisOrder = 0;
      if (isLastOrder) {
        allocationForThisOrder = round2(remainingPayment);
      } else {
        allocationForThisOrder = round2(
          Math.min(remainingPayment, remainingDue),
        );
      }

      await tx.paymentOrderAllocation.create({
        data: {
          userId,
          paymentEntryId: entry.id,
          orderId: ord.id,
          allocatedAmount: allocationForThisOrder,
          isSettled: true,
        },
      });

      remainingPayment = round2(
        Math.max(0, remainingPayment - allocationForThisOrder),
      );
    }

    return updated;
  });

  return res.json({
    message:
      "Payment entry and customer account in date range settled successfully",
    entry: updatedEntry,
  });
});

const deletePaymentEntry = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  const entry = await prisma.paymentEntry.findFirst({
    where: { id, userId },
  });

  if (!entry) {
    throw new AppError("Payment entry not found", 404);
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentOrderAllocation.deleteMany({
      where: { paymentEntryId: id },
    });

    await tx.paymentEntry.delete({
      where: { id },
    });
  });

  return res.json({ message: "Payment entry deleted successfully" });
});

const getManufacturerPaymentSummary = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { manufacturerId } = req.params;

  if (!manufacturerId) {
    throw new AppError("manufacturerId is required", 400);
  }

  const manufacturer = await prisma.manufacturer.findFirst({
    where: { id: manufacturerId, userId },
    select: {
      id: true,
      firmName: true,
      name: true,
      phone: true,
      commissionBase: true,
      commissionLotRate: true,
      commissionPercent: true,
    },
  });

  if (!manufacturer) {
    throw new AppError("Manufacturer not found", 404);
  }

  const orders = await prisma.order.findMany({
    where: {
      userId,
      manufacturerId,
      status: { not: "CANCELLED" },
    },
    select: {
      id: true,
      orderNo: true,
      orderDate: true,
      status: true,
      quantity: true,
      rate: true,
      quantityUnit: true,
      lotMeters: true,
      processedQuantity: true,
      processedMeter: true,
      meter: true,
      lot: true,
      manufacturerCommissionAmount: true,
    },
    orderBy: [{ orderDate: "desc" }, { orderNo: "desc" }],
  });

  const totalCommissionEarned = orders.reduce((sum, order) => {
    const amount =
      order.manufacturerCommissionAmount !== null &&
      order.manufacturerCommissionAmount !== undefined
        ? Number(order.manufacturerCommissionAmount)
        : computeOrderFullCommission(order, manufacturer);
    return sum + roundCurrency(amount);
  }, 0);

  const payments = await prisma.paymentEntry.findMany({
    where: {
      userId,
      partyType: "MANUFACTURER",
      manufacturerId,
    },
    select: {
      id: true,
      serialNo: true,
      amount: true,
      date: true,
      paymentMode: true,
      remark: true,
      createdAt: true,
    },
    orderBy: [{ date: "desc" }, { serialNo: "desc" }],
  });

  const totalPaymentsReceived = round2(
    payments.reduce((sum, p) => sum + Number(p.amount || 0), 0),
  );

  const balanceDue = round2(
    Math.max(0, totalCommissionEarned - totalPaymentsReceived),
  );

  return res.json({
    manufacturer,
    totalCommissionEarned: round2(totalCommissionEarned),
    totalPaymentsReceived,
    balanceDue,
    ordersCount: orders.length,
    paymentsCount: payments.length,
    recentPayments: payments.slice(0, 5),
  });
});

module.exports = {
  getNextSerialNo,
  getEligibleOrders,
  createPaymentEntry,
  listPaymentEntries,
  getPaymentEntryById,
  settlePartialAccount,
  deletePaymentEntry,
  getManufacturerPaymentSummary,
};
