const bcrypt = require("bcryptjs");
const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const { getFinancialYearStartYear, getFinancialYearLabel } = require("../utils/financialYear");
const { PENDING_PAYMENT_STATUS, round2 } = require("../utils/payments");

const ALLOWED_THEMES = ["light", "dark"];
const SALT_ROUNDS = 10;
const WHATSAPP_GROUP_INVITE_REGEX =
  /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+(?:\?.*)?$/i;
const ZERO_THRESHOLD = 0.01;
const INTEGER_TOLERANCE = 0.001;

function ensureValidFinancialYear(value, fieldName) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new AppError(`${fieldName} must be a valid financial year`, 400);
  }
  return year;
}

function validateTransferYears(sourceFyStartYear, targetFyStartYear) {
  const sourceYear = ensureValidFinancialYear(sourceFyStartYear, "sourceFyStartYear");
  const targetYear = ensureValidFinancialYear(targetFyStartYear, "targetFyStartYear");

  if (sourceYear === targetYear) {
    throw new AppError("source and target financial year cannot be the same", 400);
  }
  if (targetYear < sourceYear) {
    throw new AppError("target financial year must be later than source financial year", 400);
  }

  return { sourceYear, targetYear };
}

function getRemainingQuantity(order) {
  const quantity = Number(order?.quantity || 0);
  const processedQuantity = Number(order?.processedQuantity || 0);
  const remainingQuantity = round2(Math.max(quantity - processedQuantity, 0));
  return remainingQuantity <= ZERO_THRESHOLD ? 0 : remainingQuantity;
}

function hasWholeNumberRemainingQuantity(order) {
  const remainingQuantity = getRemainingQuantity(order);
  return Math.abs(remainingQuantity - Math.round(remainingQuantity)) <= INTEGER_TOLERANCE;
}

function getRemainingMeter(order) {
  const meter = Number(order?.meter || 0);
  const processedMeter = Number(order?.processedMeter || 0);
  const remainingMeter = round2(Math.max(meter - processedMeter, 0));
  return remainingMeter <= ZERO_THRESHOLD ? 0 : remainingMeter;
}

function getRemainingCommissionAmount(order) {
  const quantity = Number(order?.quantity || 0);
  const remainingQuantity = getRemainingQuantity(order);
  const totalCommissionAmount = Number(order?.commissionAmount || 0);

  if (!Number.isFinite(totalCommissionAmount) || totalCommissionAmount <= 0) {
    return 0;
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return round2(totalCommissionAmount);
  }

  return round2((remainingQuantity / quantity) * totalCommissionAmount);
}

function buildCarryForwardOrderPreview(
  order,
  targetFyStartYear,
  alreadyCarried = false,
  extra = {}
) {
  return {
    id: order.id,
    orderNo: order.orderNo,
    sourceFyStartYear: order.fyStartYear,
    targetFyStartYear,
    customerName: order.customer?.firmName || order.customer?.name || "-",
    manufacturerName: order.manufacturer?.firmName || order.manufacturer?.name || "-",
    qualityName: order.quality?.name || "-",
    quantity: Number(order.quantity || 0),
    processedQuantity: Number(order.processedQuantity || 0),
    remainingQuantity: getRemainingQuantity(order),
    meter: Number(order.meter || 0),
    processedMeter: Number(order.processedMeter || 0),
    remainingMeter: getRemainingMeter(order),
    quantityUnit: order.quantityUnit,
    orderDate: order.orderDate,
    status: order.status,
    alreadyCarried,
    suggestedCarryQuantity: Math.ceil(getRemainingQuantity(order)),
    requiresManualQuantity: false,
    ...extra,
  };
}

function buildCarryForwardPendingPaymentPreview(payment, targetFyStartYear, alreadyCarried = false) {
  return {
    id: payment.id,
    serialNo: payment.serialNo,
    sourceFyStartYear: payment.fyStartYear,
    targetFyStartYear,
    accountName: payment.accountName,
    amountDue: Number(payment.amountDue || 0),
    amountReceived: Number(payment.amountReceived || 0),
    balanceAmount: Number(payment.balanceAmount || 0),
    status: payment.status,
    dueDate: payment.dueDate,
    orderNo: payment.order?.orderNo || null,
    alreadyCarried,
  };
}

function buildSkippedOrderPreview(order, reason, extra = {}) {
  return {
    id: order.id,
    orderNo: order.orderNo,
    customerName: order.customer?.firmName || order.customer?.name || "-",
    manufacturerName: order.manufacturer?.firmName || order.manufacturer?.name || "-",
    qualityName: order.quality?.name || "-",
    status: order.status,
    reason,
    remainingQuantity: getRemainingQuantity(order),
    remainingMeter: getRemainingMeter(order),
    quantityUnit: order.quantityUnit,
    suggestedCarryQuantity: Math.ceil(getRemainingQuantity(order)),
    ...extra,
  };
}

function buildSkippedPendingPaymentPreview(payment, reason) {
  return {
    id: payment.id,
    serialNo: payment.serialNo,
    accountName: payment.accountName,
    status: payment.status,
    balanceAmount: Number(payment.balanceAmount || 0),
    orderNo: payment.order?.orderNo || null,
    reason,
  };
}

function isUnchangedSinceCreation(record) {
  if (!record?.createdAt || !record?.updatedAt) {
    return true;
  }
  return Math.abs(new Date(record.updatedAt).getTime() - new Date(record.createdAt).getTime()) <= 1000;
}

function analyzeYearTransferBatch(batch) {
  const blockedReasons = [];
  const carriedPayments = batch?.carriedPayments || [];
  const carriedOrders = batch?.carriedOrders || [];
  const carriedPaymentIds = new Set(carriedPayments.map((payment) => payment.id));
  const paymentLinkedOrderIds = new Set(carriedPayments.map((payment) => payment.orderId).filter(Boolean));

  if (carriedPayments.some((payment) => (payment.paymentAllocations || []).length > 0)) {
    blockedReasons.push("Some carried pending payments already have received payment allocations.");
  }
  if (carriedPayments.some((payment) => (payment.carriedForwardPayments || []).length > 0)) {
    blockedReasons.push("Some carried pending payments were already carried forward again in a later batch.");
  }
  if (carriedPayments.some((payment) => !isUnchangedSinceCreation(payment))) {
    blockedReasons.push("Some carried pending payments were modified after carry forward.");
  }

  for (const order of carriedOrders) {
    if ((order.carriedForwardOrders || []).length > 0) {
      blockedReasons.push("Some carried orders were already carried forward again in a later batch.");
      break;
    }
    if (!isUnchangedSinceCreation(order)) {
      blockedReasons.push("Some carried orders were modified after carry forward.");
      break;
    }
    const linkedPendingPayment = order.pendingPayment;
    if (linkedPendingPayment && !carriedPaymentIds.has(linkedPendingPayment.id)) {
      blockedReasons.push("Some carried orders now have pending payment records outside this batch.");
      break;
    }
    if (!paymentLinkedOrderIds.has(order.id)) {
      if (
        order.status !== "PENDING" ||
        Number(order.processedQuantity || 0) > ZERO_THRESHOLD ||
        Number(order.processedMeter || 0) > ZERO_THRESHOLD
      ) {
        blockedReasons.push("Some carried orders already have progress or status changes.");
        break;
      }
    }
  }

  return {
    canUndo: blockedReasons.length === 0,
    undoBlockedReasons: blockedReasons,
  };
}

async function getNextOrderNo(tx, userId, fyStartYear) {
  const lastOrder = await tx.order.findFirst({
    where: { userId, fyStartYear },
    orderBy: { orderNo: "desc" },
    select: { orderNo: true },
  });
  return (lastOrder?.orderNo || 0) + 1;
}

async function getNextPendingPaymentSerialNo(tx, userId, fyStartYear) {
  const latest = await tx.pendingPayment.findFirst({
    where: { userId, fyStartYear },
    orderBy: { serialNo: "desc" },
    select: { serialNo: true },
  });
  return (latest?.serialNo || 0) + 1;
}

const previewYearTransfer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { sourceYear, targetYear } = validateTransferYears(
    req.query.sourceFyStartYear,
    req.query.targetFyStartYear
  );

  const [orders, pendingPayments, carriedOrders, carriedPayments] = await Promise.all([
    prisma.order.findMany({
      where: {
        userId,
        fyStartYear: sourceYear,
      },
      include: {
        customer: true,
        manufacturer: true,
        quality: true,
      },
      orderBy: [{ orderDate: "asc" }, { orderNo: "asc" }],
    }),
    prisma.pendingPayment.findMany({
      where: {
        userId,
        fyStartYear: sourceYear,
      },
      include: {
        order: { select: { orderNo: true } },
      },
      orderBy: [{ dueDate: "asc" }, { serialNo: "asc" }],
    }),
    prisma.order.findMany({
      where: {
        userId,
        fyStartYear: targetYear,
        carriedForwardFromOrderId: { not: null },
      },
      select: {
        carriedForwardFromOrderId: true,
      },
    }),
    prisma.pendingPayment.findMany({
      where: {
        userId,
        fyStartYear: targetYear,
        carriedForwardFromPendingPaymentId: { not: null },
      },
      select: {
        carriedForwardFromPendingPaymentId: true,
      },
    }),
  ]);

  const carriedOrderIds = new Set(
    carriedOrders.map((item) => item.carriedForwardFromOrderId).filter(Boolean)
  );
  const carriedPendingPaymentIds = new Set(
    carriedPayments.map((item) => item.carriedForwardFromPendingPaymentId).filter(Boolean)
  );

  const transferableOrders = [];
  const manualCarryOrders = [];
  const skippedOrders = [];
  for (const order of orders) {
    const alreadyCarried = carriedOrderIds.has(order.id);
    const preview = buildCarryForwardOrderPreview(order, targetYear, alreadyCarried);

    if (order.status === "CANCELLED") {
      skippedOrders.push(buildSkippedOrderPreview(order, "Cancelled orders cannot be carried forward."));
      continue;
    }
    if (preview.remainingQuantity <= ZERO_THRESHOLD) {
      skippedOrders.push(buildSkippedOrderPreview(order, "No remaining quantity is left to carry forward."));
      continue;
    }
    if (!hasWholeNumberRemainingQuantity(order)) {
      manualCarryOrders.push(
        buildCarryForwardOrderPreview(order, targetYear, alreadyCarried, {
          requiresManualQuantity: true,
          manualQuantityReason:
            "Remaining quantity is fractional. Enter a whole-number carry quantity to include this order.",
        })
      );
      continue;
    }

    transferableOrders.push(preview);
  }

  const transferablePendingPayments = [];
  const skippedPendingPayments = [];
  for (const payment of pendingPayments) {
    const alreadyCarried = carriedPendingPaymentIds.has(payment.id);
    const preview = buildCarryForwardPendingPaymentPreview(payment, targetYear, alreadyCarried);

    if (![PENDING_PAYMENT_STATUS.PENDING, PENDING_PAYMENT_STATUS.PARTIAL].includes(payment.status)) {
      skippedPendingPayments.push(
        buildSkippedPendingPaymentPreview(
          payment,
          "Only pending or partial balances can be carried forward."
        )
      );
      continue;
    }
    if (Number(payment.balanceAmount || 0) <= ZERO_THRESHOLD) {
      skippedPendingPayments.push(
        buildSkippedPendingPaymentPreview(payment, "No open balance is left to carry forward.")
      );
      continue;
    }

    transferablePendingPayments.push(preview);
  }

  const warnings = [];
  if (transferableOrders.some((item) => item.alreadyCarried)) {
    warnings.push("Some orders were already carried forward to the selected target financial year.");
  }
  if (transferablePendingPayments.some((item) => item.alreadyCarried)) {
    warnings.push("Some pending payments were already carried forward to the selected target financial year.");
  }
  if (skippedOrders.length > 0 || skippedPendingPayments.length > 0) {
    warnings.push("Some records were skipped because they are not eligible for carry forward.");
  }
  if (manualCarryOrders.length > 0) {
    warnings.push(
      "Some orders need a manual carry quantity because their remaining quantity is fractional."
    );
  }

  return res.json({
    sourceFyStartYear: sourceYear,
    sourceFyLabel: getFinancialYearLabel(sourceYear),
    targetFyStartYear: targetYear,
    targetFyLabel: getFinancialYearLabel(targetYear),
    orders: transferableOrders,
    manualCarryOrders,
    pendingPayments: transferablePendingPayments,
    skippedOrders,
    skippedPendingPayments,
    warnings,
  });
});

const listYearTransferBatches = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const batches = await prisma.yearTransferBatch.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: {
          carriedOrders: true,
          carriedPayments: true,
        },
      },
      carriedOrders: {
        select: {
          id: true,
          status: true,
          processedQuantity: true,
          processedMeter: true,
          createdAt: true,
          updatedAt: true,
          pendingPayment: {
            select: {
              id: true,
            },
          },
          carriedForwardOrders: {
            select: {
              id: true,
            },
          },
        },
      },
      carriedPayments: {
        select: {
          id: true,
          orderId: true,
          createdAt: true,
          updatedAt: true,
          paymentAllocations: {
            select: {
              id: true,
            },
          },
          carriedForwardPayments: {
            select: {
              id: true,
            },
          },
        },
      },
    },
  });

  return res.json(
    batches.map((batch) => {
      const undoState = analyzeYearTransferBatch(batch);
      return {
        id: batch.id,
        sourceFyStartYear: batch.sourceFyStartYear,
        sourceFyLabel: getFinancialYearLabel(batch.sourceFyStartYear),
        targetFyStartYear: batch.targetFyStartYear,
        targetFyLabel: getFinancialYearLabel(batch.targetFyStartYear),
        carriedOrdersCount: batch._count?.carriedOrders || 0,
        carriedPendingPaymentsCount: batch._count?.carriedPayments || 0,
        createdAt: batch.createdAt,
        canUndo: undoState.canUndo,
        undoBlockedReasons: undoState.undoBlockedReasons,
      };
    })
  );
});

const getYearTransferBatchDetails = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const batchId = String(req.params.id || "");

  const batch = await prisma.yearTransferBatch.findFirst({
    where: {
      id: batchId,
      userId,
    },
    include: {
      carriedOrders: {
        include: {
          customer: {
            select: {
              firmName: true,
              name: true,
            },
          },
          manufacturer: {
            select: {
              firmName: true,
              name: true,
            },
          },
          quality: {
            select: {
              name: true,
            },
          },
          carriedForwardFromOrder: {
            select: {
              orderNo: true,
              fyStartYear: true,
            },
          },
          pendingPayment: {
            select: {
              id: true,
              transferBatchId: true,
            },
          },
          carriedForwardOrders: {
            select: {
              id: true,
            },
          },
        },
        orderBy: [{ orderNo: "asc" }],
      },
      carriedPayments: {
        include: {
          order: {
            select: {
              orderNo: true,
            },
          },
          carriedForwardFromPendingPayment: {
            select: {
              serialNo: true,
              fyStartYear: true,
              order: {
                select: {
                  orderNo: true,
                },
              },
            },
          },
          paymentAllocations: {
            select: {
              id: true,
            },
          },
          carriedForwardPayments: {
            select: {
              id: true,
            },
          },
        },
        orderBy: [{ serialNo: "asc" }],
      },
    },
  });

  if (!batch) {
    throw new AppError("carry-forward batch not found", 404);
  }

  const undoState = analyzeYearTransferBatch(batch);

  return res.json({
    id: batch.id,
    sourceFyStartYear: batch.sourceFyStartYear,
    sourceFyLabel: getFinancialYearLabel(batch.sourceFyStartYear),
    targetFyStartYear: batch.targetFyStartYear,
    targetFyLabel: getFinancialYearLabel(batch.targetFyStartYear),
    createdAt: batch.createdAt,
    carriedOrdersCount: batch.carriedOrders.length,
    carriedPendingPaymentsCount: batch.carriedPayments.length,
    canUndo: undoState.canUndo,
    undoBlockedReasons: undoState.undoBlockedReasons,
    carriedOrders: batch.carriedOrders.map((order) => ({
      id: order.id,
      orderNo: order.orderNo,
      sourceOrderNo: order.carriedForwardFromOrder?.orderNo || null,
      sourceOrderFyLabel: order.carriedForwardFromOrder?.fyStartYear
        ? getFinancialYearLabel(order.carriedForwardFromOrder.fyStartYear)
        : null,
      customerName: order.customer?.firmName || order.customer?.name || "-",
      manufacturerName: order.manufacturer?.firmName || order.manufacturer?.name || "-",
      qualityName: order.quality?.name || "-",
      quantity: Number(order.quantity || 0),
      quantityUnit: order.quantityUnit,
      meter: Number(order.meter || 0),
      commissionAmount: Number(order.commissionAmount || 0),
      status: order.status,
      orderDate: order.orderDate,
    })),
    carriedPendingPayments: batch.carriedPayments.map((payment) => ({
      id: payment.id,
      serialNo: payment.serialNo,
      sourceSerialNo: payment.carriedForwardFromPendingPayment?.serialNo || null,
      sourcePaymentFyLabel: payment.carriedForwardFromPendingPayment?.fyStartYear
        ? getFinancialYearLabel(payment.carriedForwardFromPendingPayment.fyStartYear)
        : null,
      sourceOrderNo: payment.carriedForwardFromPendingPayment?.order?.orderNo || null,
      targetOrderNo: payment.order?.orderNo || null,
      accountName: payment.accountName,
      amountDue: Number(payment.amountDue || 0),
      amountReceived: Number(payment.amountReceived || 0),
      balanceAmount: Number(payment.balanceAmount || 0),
      status: payment.status,
      dueDate: payment.dueDate,
    })),
  });
});

const executeYearTransfer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { sourceYear, targetYear } = validateTransferYears(
    req.body?.sourceFyStartYear,
    req.body?.targetFyStartYear
  );

  const standardOrderIds = Array.isArray(req.body?.orderIds)
    ? req.body.orderIds.map((id) => String(id)).filter(Boolean)
    : [];
  const orderOverrides = Array.isArray(req.body?.orderOverrides)
    ? req.body.orderOverrides
        .map((item) => ({
          id: String(item?.id || ""),
          quantity: Number(item?.quantity),
        }))
        .filter((item) => item.id)
    : [];
  const manualOrderIds = orderOverrides.map((item) => item.id);
  const pendingPaymentIds = Array.isArray(req.body?.pendingPaymentIds)
    ? req.body.pendingPaymentIds.map((id) => String(id)).filter(Boolean)
    : [];
  const orderIds = Array.from(new Set([...standardOrderIds, ...manualOrderIds]));
  const manualOrderOverrideMap = new Map(orderOverrides.map((item) => [item.id, item.quantity]));

  if (orderIds.length === 0 && pendingPaymentIds.length === 0) {
    throw new AppError("select at least one order or pending payment to carry forward", 400);
  }

  const result = await prisma.$transaction(async (tx) => {
    const [sourceOrders, sourcePendingPayments, existingCarriedOrders, existingCarriedPayments] = await Promise.all([
      orderIds.length
        ? tx.order.findMany({
            where: {
              userId,
              fyStartYear: sourceYear,
              id: { in: orderIds },
            },
            include: {
              customer: true,
              manufacturer: true,
              quality: true,
            },
          })
        : Promise.resolve([]),
      pendingPaymentIds.length
        ? tx.pendingPayment.findMany({
            where: {
              userId,
              fyStartYear: sourceYear,
              id: { in: pendingPaymentIds },
            },
            include: {
              order: true,
            },
          })
        : Promise.resolve([]),
      orderIds.length
        ? tx.order.findMany({
            where: {
              userId,
              fyStartYear: targetYear,
              carriedForwardFromOrderId: { in: orderIds },
            },
            select: { carriedForwardFromOrderId: true },
          })
        : Promise.resolve([]),
      pendingPaymentIds.length
        ? tx.pendingPayment.findMany({
            where: {
              userId,
              fyStartYear: targetYear,
              carriedForwardFromPendingPaymentId: { in: pendingPaymentIds },
            },
            select: { carriedForwardFromPendingPaymentId: true },
          })
        : Promise.resolve([]),
    ]);

    if (sourceOrders.length !== orderIds.length) {
      throw new AppError("one or more selected orders were not found", 404);
    }
    if (sourcePendingPayments.length !== pendingPaymentIds.length) {
      throw new AppError("one or more selected pending payments were not found", 404);
    }
    if (existingCarriedOrders.length > 0) {
      throw new AppError("one or more selected orders were already carried to the target financial year", 400);
    }
    if (existingCarriedPayments.length > 0) {
      throw new AppError("one or more selected pending payments were already carried to the target financial year", 400);
    }

    const eligibleOrders = sourceOrders.filter(
      (order) => {
        if (order.status === "CANCELLED" || getRemainingQuantity(order) <= ZERO_THRESHOLD) {
          return false;
        }
        if (hasWholeNumberRemainingQuantity(order)) {
          return true;
        }
        const manualQuantity = manualOrderOverrideMap.get(order.id);
        return Number.isInteger(manualQuantity) && manualQuantity > 0;
      }
    );
    const eligiblePendingPayments = sourcePendingPayments.filter(
      (payment) =>
        Number(payment.balanceAmount || 0) > ZERO_THRESHOLD &&
        [PENDING_PAYMENT_STATUS.PENDING, PENDING_PAYMENT_STATUS.PARTIAL].includes(payment.status)
    );

    if (eligibleOrders.length !== sourceOrders.length) {
      throw new AppError("one or more selected orders are not eligible for carry forward", 400);
    }
    if (eligiblePendingPayments.length !== sourcePendingPayments.length) {
      throw new AppError("one or more selected pending payments are not eligible for carry forward", 400);
    }

    const batch = await tx.yearTransferBatch.create({
      data: {
        userId,
        sourceFyStartYear: sourceYear,
        targetFyStartYear: targetYear,
      },
    });

    let nextOrderNo = await getNextOrderNo(tx, userId, targetYear);
    let nextPendingPaymentSerialNo = await getNextPendingPaymentSerialNo(tx, userId, targetYear);
    const carriedOrderBySourceId = new Map();

    const selectedPendingPaymentSourceOrderIds = Array.from(
      new Set(eligiblePendingPayments.map((payment) => payment.orderId).filter(Boolean))
    );
    const existingTargetOrdersForPendingPayments =
      selectedPendingPaymentSourceOrderIds.length > 0
        ? await tx.order.findMany({
            where: {
              userId,
              fyStartYear: targetYear,
              carriedForwardFromOrderId: { in: selectedPendingPaymentSourceOrderIds },
            },
            select: {
              id: true,
              carriedForwardFromOrderId: true,
            },
          })
        : [];

    existingTargetOrdersForPendingPayments.forEach((order) => {
      if (order.carriedForwardFromOrderId) {
        carriedOrderBySourceId.set(order.carriedForwardFromOrderId, order.id);
      }
    });

    for (const order of eligibleOrders) {
      const remainingQuantity = getRemainingQuantity(order);
      const remainingMeter = getRemainingMeter(order);
      const remainingCommissionAmount = getRemainingCommissionAmount(order);
      const hasManualQuantity = manualOrderOverrideMap.has(order.id) && !hasWholeNumberRemainingQuantity(order);
      const carryQuantity = hasManualQuantity
        ? manualOrderOverrideMap.get(order.id)
        : Math.round(remainingQuantity);
      const carryForwardNote = hasManualQuantity
        ? `Carry forward note: source remaining quantity ${remainingQuantity.toFixed(2)} ${order.quantityUnit}; carried as ${carryQuantity} ${order.quantityUnit} in ${getFinancialYearLabel(targetYear)}.`
        : null;

      const createdOrder = await tx.order.create({
        data: {
          userId,
          customerId: order.customerId,
          manufacturerId: order.manufacturerId,
          qualityId: order.qualityId,
          status: "PENDING",
          rate: order.rate,
          quantity: carryQuantity,
          processedQuantity: 0,
          processedMeter: 0,
          quantityUnit: order.quantityUnit,
          lotMeters: order.lotMeters,
          meter: remainingMeter || order.meter,
          commissionAmount: remainingCommissionAmount,
          remarks: carryForwardNote
            ? [order.remarks, carryForwardNote].filter(Boolean).join("\n")
            : order.remarks,
          customerRemark: order.customerRemark,
          manufacturerRemark: order.manufacturerRemark,
          dyeingGuarantees: order.dyeingGuarantees,
          paymentDueOn: order.paymentDueOn,
          deliveryDateFrom: order.deliveryDateFrom,
          deliveryDateTo: order.deliveryDateTo,
          fyStartYear: targetYear,
          orderNo: nextOrderNo,
          isCarryForward: true,
          carriedForwardFromOrderId: order.id,
          transferBatchId: batch.id,
          orderDate: new Date(targetYear, 3, 1),
        },
        select: { id: true },
      });

      carriedOrderBySourceId.set(order.id, createdOrder.id);
      nextOrderNo += 1;
    }

    for (const payment of eligiblePendingPayments) {
      const balanceAmount = round2(payment.balanceAmount || 0);
      let targetOrderId = carriedOrderBySourceId.get(payment.orderId);

      if (!targetOrderId) {
        const sourceOrder = await tx.order.findFirst({
          where: {
            id: payment.orderId,
            userId,
          },
          include: {
            customer: true,
            manufacturer: true,
            quality: true,
          },
        });

        if (!sourceOrder) {
          throw new AppError("source order for pending payment was not found", 404);
        }

        const createdOrder = await tx.order.create({
          data: {
            userId,
            customerId: sourceOrder.customerId,
            manufacturerId: sourceOrder.manufacturerId,
            qualityId: sourceOrder.qualityId,
            status: "COMPLETED",
            rate: sourceOrder.rate,
            quantity: sourceOrder.quantity,
            processedQuantity: sourceOrder.processedQuantity,
            processedMeter: sourceOrder.processedMeter,
            quantityUnit: sourceOrder.quantityUnit,
            lotMeters: sourceOrder.lotMeters,
            meter: sourceOrder.meter,
            commissionAmount: sourceOrder.commissionAmount,
            remarks: sourceOrder.remarks,
            customerRemark: sourceOrder.customerRemark,
            manufacturerRemark: sourceOrder.manufacturerRemark,
            dyeingGuarantees: sourceOrder.dyeingGuarantees,
            paymentDueOn: sourceOrder.paymentDueOn,
            deliveryDateFrom: sourceOrder.deliveryDateFrom,
            deliveryDateTo: sourceOrder.deliveryDateTo,
            fyStartYear: targetYear,
            orderNo: nextOrderNo,
            isCarryForward: true,
            carriedForwardFromOrderId: sourceOrder.id,
            transferBatchId: batch.id,
            orderDate: new Date(targetYear, 3, 1),
          },
          select: { id: true },
        });

        targetOrderId = createdOrder.id;
        carriedOrderBySourceId.set(sourceOrder.id, createdOrder.id);
        nextOrderNo += 1;
      }

      await tx.pendingPayment.create({
        data: {
          userId,
          orderId: targetOrderId,
          fyStartYear: targetYear,
          serialNo: nextPendingPaymentSerialNo,
          isCarryForward: true,
          carriedForwardFromPendingPaymentId: payment.id,
          transferBatchId: batch.id,
          accountName: payment.accountName,
          amountDue: balanceAmount,
          amountReceived: 0,
          finalSettledAmount: null,
          discountAmount: 0,
          discountPercent: 0,
          balanceAmount,
          status: PENDING_PAYMENT_STATUS.PENDING,
          dueDate: payment.dueDate,
          settledAt: null,
        },
      });

      nextPendingPaymentSerialNo += 1;
    }

    return {
      batchId: batch.id,
      carriedOrders: eligibleOrders.length,
      carriedPendingPayments: eligiblePendingPayments.length,
    };
  });

  return res.status(201).json(result);
});

const undoYearTransferBatch = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const batchId = String(req.params.id || "");

  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.yearTransferBatch.findFirst({
      where: {
        id: batchId,
        userId,
      },
      include: {
        carriedOrders: {
          select: {
            id: true,
            status: true,
            processedQuantity: true,
            processedMeter: true,
            createdAt: true,
            updatedAt: true,
            pendingPayment: {
              select: {
                id: true,
                transferBatchId: true,
              },
            },
            carriedForwardOrders: {
              select: {
                id: true,
              },
            },
          },
        },
        carriedPayments: {
          select: {
            id: true,
            orderId: true,
            createdAt: true,
            updatedAt: true,
            paymentAllocations: {
              select: {
                id: true,
              },
            },
            carriedForwardPayments: {
              select: {
                id: true,
              },
            },
          },
        },
      },
    });

    if (!batch) {
      throw new AppError("carry-forward batch not found", 404);
    }

    const undoState = analyzeYearTransferBatch(batch);
    if (!undoState.canUndo) {
      throw new AppError(
        `Carry-forward batch cannot be undone. ${undoState.undoBlockedReasons.join(" ")}`,
        400
      );
    }

    const carriedPaymentIds = batch.carriedPayments.map((payment) => payment.id);
    const carriedOrderIds = batch.carriedOrders.map((order) => order.id);

    if (carriedPaymentIds.length > 0) {
      await tx.pendingPayment.deleteMany({
        where: {
          id: { in: carriedPaymentIds },
          userId,
          transferBatchId: batch.id,
        },
      });
    }

    if (carriedOrderIds.length > 0) {
      await tx.order.deleteMany({
        where: {
          id: { in: carriedOrderIds },
          userId,
          transferBatchId: batch.id,
        },
      });
    }

    await tx.yearTransferBatch.delete({
      where: { id: batch.id },
    });

    return {
      batchId: batch.id,
      removedOrders: carriedOrderIds.length,
      removedPendingPayments: carriedPaymentIds.length,
    };
  });

  return res.json(result);
});

const listUsers = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      theme: true,
      selectedFinancialYearStart: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) {
    throw new AppError("user not found", 404);
  }

  return res.json([
    {
      ...user,
      selectedFinancialYearStart:
        user.selectedFinancialYearStart ?? getFinancialYearStartYear(),
    },
  ]);
});

const getMyPreferences = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      theme: true,
      selectedFinancialYearStart: true,
    },
  });

  if (!user) {
    throw new AppError("user not found", 404);
  }

  const selectedFinancialYearStart =
    user.selectedFinancialYearStart ?? getFinancialYearStartYear();

  return res.json({
    theme: user.theme,
    selectedFinancialYearStart,
    selectedFinancialYearLabel: getFinancialYearLabel(selectedFinancialYearStart),
  });
});

const updateMyPreferences = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { theme, selectedFinancialYearStart } = req.body;
  const hasTheme = theme !== undefined;
  const hasFinancialYear = selectedFinancialYearStart !== undefined;

  if (!hasTheme && !hasFinancialYear) {
    throw new AppError("at least one preference field is required", 400);
  }

  const data = {};

  if (hasTheme) {
    if (!theme || !ALLOWED_THEMES.includes(theme)) {
      throw new AppError("theme must be one of: light, dark", 400);
    }
    data.theme = theme;
  }

  if (hasFinancialYear) {
    const nextFinancialYear = Number(selectedFinancialYearStart);
    if (!Number.isInteger(nextFinancialYear) || nextFinancialYear < 2000 || nextFinancialYear > 2100) {
      throw new AppError("selectedFinancialYearStart must be a valid financial year", 400);
    }
    data.selectedFinancialYearStart = nextFinancialYear;
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data,
    select: {
      theme: true,
      selectedFinancialYearStart: true,
    },
  });

  const effectiveFinancialYear =
    updated.selectedFinancialYearStart ?? getFinancialYearStartYear();

  return res.json({
    theme: updated.theme,
    selectedFinancialYearStart: effectiveFinancialYear,
    selectedFinancialYearLabel: getFinancialYearLabel(effectiveFinancialYear),
  });
});

const updateMyProfile = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { name, email, currentPassword, newPassword } = req.body;

  const hasName = name !== undefined;
  const hasEmail = email !== undefined;
  const hasCurrentPassword = currentPassword !== undefined && currentPassword !== "";
  const hasNewPassword = newPassword !== undefined && newPassword !== "";

  if (!hasName && !hasEmail && !hasCurrentPassword && !hasNewPassword) {
    throw new AppError("at least one field is required", 400);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
  });
  if (!user) {
    throw new AppError("user not found", 404);
  }

  const updateData = {};

  if (hasName) {
    updateData.name = String(name || "").trim() || null;
  }

  if (hasEmail) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail) {
      throw new AppError("email cannot be empty", 400);
    }
    updateData.email = normalizedEmail;
  }

  if (hasCurrentPassword || hasNewPassword) {
    if (!hasCurrentPassword || !hasNewPassword) {
      throw new AppError("currentPassword and newPassword are both required", 400);
    }
    if (String(newPassword).length < 8) {
      throw new AppError("newPassword must be at least 8 characters", 400);
    }
    const isCurrentPasswordValid = await bcrypt.compare(String(currentPassword), user.password);
    if (!isCurrentPasswordValid) {
      throw new AppError("current password is incorrect", 400);
    }
    updateData.password = await bcrypt.hash(String(newPassword), SALT_ROUNDS);
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: updateData,
    select: {
      id: true,
      email: true,
      name: true,
      theme: true,
      selectedFinancialYearStart: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return res.json({
    ...updated,
    selectedFinancialYearStart:
      updated.selectedFinancialYearStart ?? getFinancialYearStartYear(),
  });
});

const listMyRemarkTemplates = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const templates = await prisma.remarkTemplate.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  return res.json(templates);
});

const createMyRemarkTemplate = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const text = String(req.body?.text || "").trim();

  if (!text) {
    throw new AppError("text is required", 400);
  }

  const created = await prisma.remarkTemplate.create({
    data: { userId, text },
  });
  return res.status(201).json(created);
});

const deleteMyRemarkTemplate = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const deleted = await prisma.remarkTemplate.deleteMany({
    where: { id, userId },
  });
  if (deleted.count === 0) {
    throw new AppError("remark template not found", 404);
  }
  return res.status(204).send();
});

const listMyWhatsAppGroups = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const groups = await prisma.whatsAppGroup.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  return res.json(groups);
});

const createMyWhatsAppGroup = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const name = String(req.body?.name || "").trim();
  const inviteLink = String(req.body?.inviteLink || "").trim();

  if (!name) {
    throw new AppError("name is required", 400);
  }
  if (!inviteLink || !WHATSAPP_GROUP_INVITE_REGEX.test(inviteLink)) {
    throw new AppError("inviteLink must be a valid WhatsApp group link", 400);
  }

  const created = await prisma.whatsAppGroup.create({
    data: { userId, name, inviteLink },
  });
  return res.status(201).json(created);
});

const updateMyWhatsAppGroup = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const hasName = req.body?.name !== undefined;
  const hasInviteLink = req.body?.inviteLink !== undefined;

  if (!hasName && !hasInviteLink) {
    throw new AppError("at least one field is required", 400);
  }

  const existing = await prisma.whatsAppGroup.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!existing) {
    throw new AppError("whatsapp group not found", 404);
  }

  const data = {};
  if (hasName) {
    const name = String(req.body.name || "").trim();
    if (!name) {
      throw new AppError("name cannot be empty", 400);
    }
    data.name = name;
  }
  if (hasInviteLink) {
    const inviteLink = String(req.body.inviteLink || "").trim();
    if (!inviteLink || !WHATSAPP_GROUP_INVITE_REGEX.test(inviteLink)) {
      throw new AppError("inviteLink must be a valid WhatsApp group link", 400);
    }
    data.inviteLink = inviteLink;
  }

  const updated = await prisma.whatsAppGroup.update({
    where: { id },
    data,
  });
  return res.json(updated);
});

const deleteMyWhatsAppGroup = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const deleted = await prisma.whatsAppGroup.deleteMany({
    where: { id, userId },
  });
  if (deleted.count === 0) {
    throw new AppError("whatsapp group not found", 404);
  }
  return res.status(204).send();
});

module.exports = {
  listUsers,
  getMyPreferences,
  updateMyPreferences,
  updateMyProfile,
  listMyRemarkTemplates,
  createMyRemarkTemplate,
  deleteMyRemarkTemplate,
  listMyWhatsAppGroups,
  createMyWhatsAppGroup,
  updateMyWhatsAppGroup,
  deleteMyWhatsAppGroup,
  previewYearTransfer,
  executeYearTransfer,
  listYearTransferBatches,
  getYearTransferBatchDetails,
  undoYearTransferBatch,
};
