const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const { Prisma } = require("@prisma/client");
const { buildOrderWhatsAppLinks, buildOrderWhatsAppMessages } = require("../utils/whatsapp");
const { getFinancialYearStartYear } = require("../utils/financialYear");
const {
  getNextPendingPaymentSerialNo,
  getPendingPaymentStatus,
  isPendingPaymentSerialConflict,
} = require("../utils/payments");
const {
  buildPaginatedResponse,
  normalizeSearch,
  tokenizeSearch,
  parsePagination,
  parseSort,
} = require("../utils/listQuery");
const {
  ORDER_ACTIVITY_ACTIONS,
  buildOrderAuditSnapshot,
  getChangedFields,
  recordOrderActivity,
} = require("../utils/orderActivity");

function normalizeOrder(order) {
  const processedQuantity = Number(order.processedQuantity || 0);
  const processedMeter = Number(order.processedMeter || 0);
  const normalizedCommissionAmount = order.commissionAmount === null ? null : Number(order.commissionAmount);
  const progressCommissionAmount =
    computeLiveProgressCommissionAmount(order);

  return {
    ...order,
    processedQuantity,
    processedMeter,
    rate: round2(order.rate),
    lotMeters: order.lotMeters === null ? null : Number(order.lotMeters),
    meter: order.meter === null ? null : Number(order.meter),
    commissionAmount: normalizedCommissionAmount,
    progressCommissionAmount,
    whatsappMessages: buildOrderWhatsAppMessages(order),
    whatsappLinks: buildOrderWhatsAppLinks(order),
  };
}

const QUANTITY_UNITS = {
  TAKKA: "TAKKA",
  LOT: "LOT",
  METER: "METER",
};
const ORDER_STATUS = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
};
const TAKKA_PER_LOT = 12;
const LOT_MIN_METERS = 1400;
const LOT_MAX_METERS = 1500;
const GST_RATE = 0.05;
const DEFAULT_COMMISSION_PERCENT = 1;
const ORDER_NO_RETRY_LIMIT = 3;
const PENDING_PAYMENT_RETRY_LIMIT = 3;

function getRandomLotMeters() {
  const quarterSteps = [0.25, 0.5, 0.75];
  const minWhole = Math.ceil(LOT_MIN_METERS);
  const maxWhole = Math.floor(LOT_MAX_METERS);
  const wholePart = Math.floor(Math.random() * (maxWhole - minWhole + 1)) + minWhole;
  const decimalPart = quarterSteps[Math.floor(Math.random() * quarterSteps.length)];
  const candidate = wholePart + decimalPart;
  return candidate > LOT_MAX_METERS ? LOT_MAX_METERS - 0.25 : candidate;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function roundCurrency(value) {
  return Math.round(Number(value || 0));
}

function needsLotMetersBasis(quantityUnit, customerCommissionConfig) {
  const normalizedUnit = String(quantityUnit || "").toUpperCase();
  const commissionBase = String(customerCommissionConfig?.commissionBase || "PERCENT").toUpperCase();
  return normalizedUnit === QUANTITY_UNITS.LOT ||
    normalizedUnit === QUANTITY_UNITS.TAKKA ||
    (normalizedUnit === QUANTITY_UNITS.METER && commissionBase === "LOT");
}

function computeProportionalCommissionAmount({
  processedQuantity,
  totalQuantity,
  processedMeter,
  totalMeter,
  fullCommissionAmount,
}) {
  const normalizedFullCommission = Number(fullCommissionAmount || 0);
  if (!Number.isFinite(normalizedFullCommission) || normalizedFullCommission <= 0) {
    return 0;
  }

  const normalizedProcessedMeter = Number(processedMeter || 0);
  const normalizedTotalMeter = Number(totalMeter || 0);
  if (
    Number.isFinite(normalizedProcessedMeter) &&
    Number.isFinite(normalizedTotalMeter) &&
    normalizedTotalMeter > 0
  ) {
    return roundCurrency((normalizedFullCommission * normalizedProcessedMeter) / normalizedTotalMeter);
  }

  const normalizedTotalQuantity = Number(totalQuantity || 0);
  if (!Number.isFinite(normalizedTotalQuantity) || normalizedTotalQuantity <= 0) {
    return roundCurrency(normalizedFullCommission);
  }

  const normalizedProcessedQuantity = Math.max(Number(processedQuantity || 0), 0);
  const completionRatio = normalizedProcessedQuantity / normalizedTotalQuantity;
  return roundCurrency(normalizedFullCommission * completionRatio);
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

function resolveOrderActivityAction(beforeStatus, afterStatus, updateData) {
  const normalizedBefore = String(beforeStatus || "").toUpperCase();
  const normalizedAfter = String(afterStatus || "").toUpperCase();

  if (normalizedAfter === ORDER_STATUS.COMPLETED && normalizedBefore !== ORDER_STATUS.COMPLETED) {
    return ORDER_ACTIVITY_ACTIONS.COMPLETED;
  }
  if (
    normalizedAfter === ORDER_STATUS.PENDING &&
    (normalizedBefore === ORDER_STATUS.COMPLETED || normalizedBefore === ORDER_STATUS.CANCELLED)
  ) {
    return ORDER_ACTIVITY_ACTIONS.REOPENED;
  }
  if (normalizedAfter === ORDER_STATUS.CANCELLED) {
    return ORDER_ACTIVITY_ACTIONS.CANCELLED;
  }
  if (
    updateData.processedQuantity !== undefined ||
    updateData.processedMeter !== undefined ||
    updateData.processedQuantityAdd !== undefined
  ) {
    return ORDER_ACTIVITY_ACTIONS.PROGRESS_UPDATED;
  }
  return ORDER_ACTIVITY_ACTIONS.UPDATED;
}

function parseLotMetersInput(value, quantityUnit) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AppError("lotMeters must be greater than 0 when provided", 400);
  }

  return parsed;
}

function parseOrderDateOrThrow(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError("orderDate is invalid", 400);
  }
  return date;
}

function parseOptionalDateOrThrow(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(`${fieldName} is invalid`, 400);
  }
  return date;
}

function addDays(dateValue, days) {
  if (!Number.isFinite(days)) {
    return null;
  }
  const date = new Date(dateValue);
  date.setDate(date.getDate() + days);
  return date;
}

async function getNextOrderNo(tx, userId, fyStartYear) {
  const lastOrder = await tx.order.findFirst({
    where: { userId, fyStartYear },
    orderBy: { orderNo: "desc" },
    select: { orderNo: true },
  });
  return (lastOrder?.orderNo || 0) + 1;
}

async function getSelectedFinancialYearStartForUser(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { selectedFinancialYearStart: true },
  });

  if (!user) {
    throw new AppError("user not found", 404);
  }

  return user.selectedFinancialYearStart ?? getFinancialYearStartYear();
}

function isOrderNoUniqueConflict(error) {
  if (error?.code !== "P2002") return false;
  const target = error?.meta?.target;
  if (Array.isArray(target)) {
    return (
      target.includes("userId") &&
      target.includes("fyStartYear") &&
      target.includes("orderNo")
    );
  }
  return String(target || "").includes("Order_userId_fyStartYear_orderNo_key");
}

function toMeterFromQuantity({ quantity, quantityUnit, lotMeters }) {
  if (quantityUnit === QUANTITY_UNITS.METER) {
    return quantity;
  }
  if (!Number.isFinite(lotMeters) || lotMeters <= 0) {
    throw new AppError("lot meter value is required for TAKKA/LOT conversion", 400);
  }
  if (quantityUnit === QUANTITY_UNITS.LOT) {
    return quantity * lotMeters;
  }
  return quantity * (lotMeters / TAKKA_PER_LOT);
}

function toQuantityFromMeter({ meter, quantityUnit, lotMeters }) {
  if (quantityUnit === QUANTITY_UNITS.METER) {
    return meter;
  }
  if (!Number.isFinite(lotMeters) || lotMeters <= 0) {
    throw new AppError("lot meter value is required for TAKKA/LOT conversion", 400);
  }
  if (quantityUnit === QUANTITY_UNITS.LOT) {
    return meter / lotMeters;
  }
  return meter / (lotMeters / TAKKA_PER_LOT);
}

function convertQuantityToOrderUnit({ quantity, inputUnit, orderUnit, lotMeters }) {
  const normalizedInputUnit = String(inputUnit || "").toUpperCase();
  const normalizedOrderUnit = String(orderUnit || "").toUpperCase();
  const meter =
    normalizedInputUnit === QUANTITY_UNITS.METER
      ? quantity
      : toMeterFromQuantity({
          quantity,
          quantityUnit: normalizedInputUnit,
          lotMeters,
        });

  return normalizedOrderUnit === QUANTITY_UNITS.METER
    ? meter
    : toQuantityFromMeter({
        meter,
        quantityUnit: normalizedOrderUnit,
        lotMeters,
      });
}

function toLotQuantity({ quantity, quantityUnit, lotMeters }) {
  if (quantityUnit === QUANTITY_UNITS.LOT) {
    return quantity;
  }
  if (quantityUnit === QUANTITY_UNITS.TAKKA) {
    return quantity / TAKKA_PER_LOT;
  }
  if (!Number.isFinite(lotMeters) || lotMeters <= 0) {
    throw new AppError("lot meter value is required for METER to LOT conversion", 400);
  }
  return quantity / lotMeters;
}

function computeStoredLotValue({ quantity, quantityUnit, lotMeters }) {
  const normalizedQuantity = Number(quantity || 0);
  const normalizedUnit = String(quantityUnit || "").toUpperCase();
  const normalizedLotMeters = Number(lotMeters || 0);

  if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
    return null;
  }

  if (normalizedUnit === QUANTITY_UNITS.LOT) {
    return Math.round(normalizedQuantity);
  }

  if (normalizedUnit === QUANTITY_UNITS.TAKKA) {
    return Math.round(normalizedQuantity / TAKKA_PER_LOT);
  }

  if (normalizedUnit === QUANTITY_UNITS.METER) {
    if (!Number.isFinite(normalizedLotMeters) || normalizedLotMeters <= 0) {
      return null;
    }
    return Math.round(normalizedQuantity / normalizedLotMeters);
  }

  return null;
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
      ? Number(customerCommissionConfig?.commissionPercent)
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
  const baseAmount = meter * rate;
  const gstAmount = baseAmount * GST_RATE;
  return roundCurrency((baseAmount + gstAmount) * (commissionPercent / 100));
}

function computeOrderAmounts(
  quantity,
  rate,
  quantityUnit,
  customerCommissionConfig,
  existingLotMeters
) {
  const normalizedUnit = Object.values(QUANTITY_UNITS).includes(quantityUnit)
    ? quantityUnit
    : QUANTITY_UNITS.TAKKA;

  const parsedExistingLotMeters = Number(existingLotMeters);
  const shouldUseLotMeters =
    needsLotMetersBasis(normalizedUnit, customerCommissionConfig) ||
    normalizedUnit === QUANTITY_UNITS.METER;
  const lotMeters = shouldUseLotMeters
    ? Number.isFinite(parsedExistingLotMeters) && parsedExistingLotMeters > 0
      ? parsedExistingLotMeters
      : getRandomLotMeters()
    : null;

  const meter =
    normalizedUnit === QUANTITY_UNITS.METER
      ? quantity
      : toMeterFromQuantity({ quantity, quantityUnit: normalizedUnit, lotMeters });
  const lot = computeStoredLotValue({
    quantity,
    quantityUnit: normalizedUnit,
    lotMeters,
  });
  const commissionAmount = computeCommissionAmount({
    quantityForCommission: quantity,
    rate,
    quantityUnit: normalizedUnit,
    lotMeters,
    customerCommissionConfig,
  });

  return {
    quantityUnit: normalizedUnit,
    lotMeters: lotMeters === null ? null : round2(lotMeters),
    lot,
    meter: round2(meter),
    commissionAmount: roundCurrency(commissionAmount),
  };
}

function getPendingPaymentAccountName(order) {
  return String(order?.customer?.firmName || order?.customer?.name || "").trim();
}

async function syncPendingPaymentForCompletedOrder(tx, order) {
  const amountDue = round2(order?.commissionAmount || 0);
  if (amountDue <= 0) {
    return null;
  }

  const accountName = getPendingPaymentAccountName(order);
  const paymentDueOn = Number(order?.paymentDueOn);
  const dueDate =
    Number.isInteger(paymentDueOn) && paymentDueOn >= 0 ? addDays(order.orderDate, paymentDueOn) : null;

  const existing = await tx.pendingPayment.findUnique({
    where: { orderId: order.id },
    select: {
      id: true,
      amountReceived: true,
      paymentAllocations: {
        select: {
          isFinalSettlement: true,
        },
      },
    },
  });

  if (existing) {
    const amountReceived = round2(existing.amountReceived || 0);
    const hasFinalSettlement = existing.paymentAllocations.some(
      (allocation) => allocation.isFinalSettlement
    );
    const discountAmount = hasFinalSettlement
      ? round2(Math.max(amountDue - amountReceived, 0))
      : 0;
    const finalSettledAmount = hasFinalSettlement ? amountReceived : null;
    const balanceAmount = hasFinalSettlement
      ? 0
      : round2(Math.max(amountDue - amountReceived, 0));
    const status = getPendingPaymentStatus({
      amountDue,
      amountReceived,
      discountAmount,
      hasFinalSettlement,
    });

    return tx.pendingPayment.update({
      where: { id: existing.id },
      data: {
        accountName,
        amountDue,
        finalSettledAmount,
        discountAmount,
        discountPercent: amountDue > 0 ? round2((discountAmount / amountDue) * 100) : 0,
        balanceAmount,
        status,
        dueDate,
        settledAt: status === "PAID" || status === "SETTLED" ? new Date() : null,
      },
    });
  }

  for (let attempt = 0; attempt < PENDING_PAYMENT_RETRY_LIMIT; attempt += 1) {
    try {
      const serialNo = await getNextPendingPaymentSerialNo(tx, order.userId, order.fyStartYear);
      return await tx.pendingPayment.create({
        data: {
          userId: order.userId,
          orderId: order.id,
          fyStartYear: order.fyStartYear,
          serialNo,
          accountName,
          amountDue,
          amountReceived: 0,
          finalSettledAmount: null,
          discountAmount: 0,
          discountPercent: 0,
          balanceAmount: amountDue,
          status: "PENDING",
          dueDate,
        },
      });
    } catch (error) {
      if (isPendingPaymentSerialConflict(error) && attempt < PENDING_PAYMENT_RETRY_LIMIT - 1) {
        continue;
      }
      throw error;
    }
  }

  return null;
}

async function syncPendingPaymentForOrder(tx, order) {
  if (order.status === ORDER_STATUS.COMPLETED) {
    return syncPendingPaymentForCompletedOrder(tx, order);
  }

  const existing = await tx.pendingPayment.findUnique({
    where: { orderId: order.id },
    select: {
      id: true,
      paymentAllocations: { select: { id: true }, take: 1 },
    },
  });

  if (!existing) {
    return null;
  }

  if (existing.paymentAllocations.length > 0) {
    throw new AppError(
      "cannot change completed order status after receiving payment against it",
      400
    );
  }

  await tx.pendingPayment.delete({
    where: { id: existing.id },
  });

  return null;
}

async function resolveQualityId(tx, userId, qualityName) {
  const normalized = qualityName?.trim();
  if (!normalized) {
    throw new AppError("qualityName is required", 400);
  }

  const existing = await tx.quality.findFirst({
    where: { userId, name: normalized },
    select: { id: true, isActive: true },
  });

  if (existing) {
    if (!existing.isActive) {
      const reactivated = await tx.quality.update({
        where: { id: existing.id },
        data: { isActive: true },
        select: { id: true },
      });
      return reactivated.id;
    }
    return existing.id;
  }

  const created = await tx.quality.create({
    data: { userId, name: normalized, isActive: true },
    select: { id: true },
  });

  return created.id;
}

const createOrder = asyncHandler(async (req, res) => {
  const {
    customerId,
    manufacturerId,
    rate,
    quantity,
    quantityUnit,
    lotMeters,
    qualityName,
    orderDate,
    remarks,
    customerRemark,
    manufacturerRemark,
    dyeingGuarantees,
    paymentDueOn,
    deliveryDateFrom,
    deliveryDateTo,
  } =
    req.body;
  const userId = req.user.userId;

  if (!customerId || !manufacturerId || rate === undefined || quantity === undefined || !orderDate) {
    throw new AppError(
      "customerId, manufacturerId, rate, quantity, orderDate are required",
      400
    );
  }

  if (Number(quantity) <= 0 || Number(rate) <= 0) {
    throw new AppError("quantity and rate must be greater than 0", 400);
  }

  if (quantityUnit !== undefined && !Object.values(QUANTITY_UNITS).includes(quantityUnit)) {
    throw new AppError("quantityUnit must be one of: TAKKA, LOT, METER", 400);
  }

  const normalizedQuantityUnit = quantityUnit || QUANTITY_UNITS.TAKKA;
  const parsedLotMeters = parseLotMetersInput(lotMeters, normalizedQuantityUnit);

  if (
    paymentDueOn !== undefined &&
    (!Number.isInteger(Number(paymentDueOn)) || Number(paymentDueOn) < 0)
  ) {
    throw new AppError("paymentDueOn must be a whole number of days and cannot be negative", 400);
  }

  const parsedOrderDate = parseOrderDateOrThrow(orderDate);
  const parsedDeliveryDateFrom = parseOptionalDateOrThrow(deliveryDateFrom, "deliveryDateFrom");
  const parsedDeliveryDateTo = parseOptionalDateOrThrow(deliveryDateTo, "deliveryDateTo");
  if (parsedDeliveryDateFrom && parsedDeliveryDateTo && parsedDeliveryDateFrom > parsedDeliveryDateTo) {
    throw new AppError("deliveryDateFrom cannot be after deliveryDateTo", 400);
  }
  const fyStartYear = getFinancialYearStartYear(parsedOrderDate);
  let order;

  for (let attempt = 0; attempt < ORDER_NO_RETRY_LIMIT; attempt += 1) {
    try {
      order = await prisma.$transaction(async (tx) => {
        const [customer, manufacturer] = await Promise.all([
          tx.customer.findFirst({
            where: { id: customerId, userId },
            select: {
              id: true,
              commissionBase: true,
              commissionPercent: true,
              commissionLotRate: true,
            },
          }),
          tx.manufacturer.findFirst({ where: { id: manufacturerId, userId }, select: { id: true } }),
        ]);

        if (!customer) {
          throw new AppError("customer not found", 404);
        }
        if (!manufacturer) {
          throw new AppError("manufacturer not found", 404);
        }

        const qualityId = await resolveQualityId(tx, userId, qualityName);
        const amountData = computeOrderAmounts(
          Number(quantity),
          Number(rate),
          normalizedQuantityUnit,
          customer,
          parsedLotMeters
        );
        const nextOrderNo = await getNextOrderNo(tx, userId, fyStartYear);

        const createdOrder = await tx.order.create({
          data: {
            userId,
            fyStartYear,
            orderNo: nextOrderNo,
            customerId,
            manufacturerId,
            qualityId,
            rate: round2(Number(rate)),
            quantity: Number(quantity),
            processedQuantity: 0,
            processedMeter: 0,
            status: ORDER_STATUS.PENDING,
            quantityUnit: amountData.quantityUnit,
            lotMeters: amountData.lotMeters,
            lot: amountData.lot,
            meter: amountData.meter,
            commissionAmount: 0,
            remarks: remarks?.trim() || null,
            customerRemark: customerRemark?.trim() || null,
            manufacturerRemark: manufacturerRemark?.trim() || null,
            dyeingGuarantees: Boolean(dyeingGuarantees),
            paymentDueOn: paymentDueOn !== undefined ? Number(paymentDueOn) : null,
            deliveryDateFrom: parsedDeliveryDateFrom,
            deliveryDateTo: parsedDeliveryDateTo,
            orderDate: parsedOrderDate,
          },
          include: {
            user: { select: { id: true, name: true, email: true } },
            customer: true,
            manufacturer: true,
            quality: true,
          },
        });

        await recordOrderActivity(tx, {
          userId,
          orderId: createdOrder.id,
          action: ORDER_ACTIVITY_ACTIONS.CREATED,
          beforeData: null,
          afterData: buildOrderAuditSnapshot(createdOrder),
        });

        return createdOrder;
      });
      break;
    } catch (error) {
      if (isOrderNoUniqueConflict(error) && attempt < ORDER_NO_RETRY_LIMIT - 1) {
        continue;
      }
      throw error;
    }
  }

  return res.status(201).json(normalizeOrder(order));
});

const ORDER_SORT_FIELDS = [
  "orderNo",
  "status",
  "orderDate",
  "rate",
  "quantity",
  "processedQuantity",
  "processedMeter",
  "commissionAmount",
  "createdAt",
  "updatedAt",
  "customerName",
  "manufacturerName",
  "qualityName",
];

function buildOrderSort(sortBy, sortOrder) {
  if (sortBy === "customerName") {
    return { customer: { name: sortOrder } };
  }
  if (sortBy === "manufacturerName") {
    return { manufacturer: { name: sortOrder } };
  }
  if (sortBy === "qualityName") {
    return { quality: { name: sortOrder } };
  }
  return { [sortBy]: sortOrder };
}

const ORDER_NUMERIC_SEARCH_FIELDS = [
  { field: "orderNo", type: "int" },
  { field: "quantity", type: "int" },
  { field: "processedQuantity", type: "decimal" },
  { field: "processedMeter", type: "decimal" },
  { field: "rate", type: "decimal" },
  { field: "lotMeters", type: "decimal" },
  { field: "meter", type: "decimal" },
  { field: "commissionAmount", type: "decimal" },
  { field: "paymentDueOn", type: "int" },
];

function parseNumericSearchToken(token) {
  const normalized = String(token || "").trim();
  if (!normalized) {
    return null;
  }

  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildOrderSearchClause(token) {
  const numericValue = parseNumericSearchToken(token);
  const normalizedToken = String(token || "").trim();
  const upperToken = normalizedToken.toUpperCase();
  const orConditions = [];

  if (numericValue !== null) {
    orConditions.push(
      ...ORDER_NUMERIC_SEARCH_FIELDS.map((entry) => ({
        [entry.field]: numericValue,
      }))
    );
  }

  if (normalizedToken && numericValue === null) {
    orConditions.push(
      { customer: { firmName: { contains: normalizedToken, mode: "insensitive" } } },
      { customer: { name: { contains: normalizedToken, mode: "insensitive" } } },
      { manufacturer: { firmName: { contains: normalizedToken, mode: "insensitive" } } },
      { manufacturer: { name: { contains: normalizedToken, mode: "insensitive" } } },
      { quality: { name: { contains: normalizedToken, mode: "insensitive" } } },
      { remarks: { contains: normalizedToken, mode: "insensitive" } },
      { customerRemark: { contains: normalizedToken, mode: "insensitive" } },
      { manufacturerRemark: { contains: normalizedToken, mode: "insensitive" } }
    );
  }

  if (Object.values(ORDER_STATUS).includes(upperToken)) {
    orConditions.push({ status: upperToken });
  }

  if (!orConditions.length) {
    return null;
  }

  return { OR: orConditions };
}

function buildOrderSearchWhere(searchField, search) {
  const normalizedSearch = normalizeSearch(search);
  if (!normalizedSearch) {
    return null;
  }

  const selectedField = String(searchField || "").trim();
  const numericValue = parseNumericSearchToken(normalizedSearch);

  switch (selectedField) {
    case "orderNo":
      return numericValue === null ? { id: "__no_order_search_match__" } : { orderNo: numericValue };
    case "orderDate": {
      const date = new Date(normalizedSearch);
      if (Number.isNaN(date.getTime())) {
        return { id: "__no_order_search_match__" };
      }
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      return {
        orderDate: {
          gte: start,
          lte: end,
        },
      };
    }
    case "customerName":
      return { customer: { name: { contains: normalizedSearch, mode: "insensitive" } } };
    case "customerFirmName":
      return { customer: { firmName: { contains: normalizedSearch, mode: "insensitive" } } };
    case "manufacturerName":
      return { manufacturer: { name: { contains: normalizedSearch, mode: "insensitive" } } };
    case "manufacturerFirmName":
      return { manufacturer: { firmName: { contains: normalizedSearch, mode: "insensitive" } } };
    case "qualityName":
      return { quality: { name: { contains: normalizedSearch, mode: "insensitive" } } };
    case "quantity":
    case "processedQuantity":
    case "processedMeter":
    case "rate":
    case "lotMeters":
    case "meter":
    case "commissionAmount":
      return numericValue === null
        ? { id: "__no_order_search_match__" }
        : { [selectedField]: numericValue };
    case "paymentDueOn":
      return numericValue === null || !Number.isInteger(numericValue)
        ? { id: "__no_order_search_match__" }
        : { paymentDueOn: numericValue };
    case "status": {
      const status = normalizedSearch.toUpperCase();
      return Object.values(ORDER_STATUS).includes(status)
        ? { status }
        : { id: "__no_order_search_match__" };
    }
    case "remarks":
      return { remarks: { contains: normalizedSearch, mode: "insensitive" } };
    case "customerRemark":
      return { customerRemark: { contains: normalizedSearch, mode: "insensitive" } };
    case "manufacturerRemark":
      return { manufacturerRemark: { contains: normalizedSearch, mode: "insensitive" } };
    default: {
      const searchTokens = tokenizeSearch(normalizedSearch);
      const searchConditions = searchTokens.map((token) => buildOrderSearchClause(token)).filter(Boolean);
      return searchConditions.length ? { AND: searchConditions } : null;
    }
  }
}

const ORDER_NUMERIC_SUBSTRING_FIELDS = new Set([
  "orderNo",
  "quantity",
  "processedQuantity",
  "processedMeter",
  "rate",
  "lotMeters",
  "meter",
  "commissionAmount",
  "paymentDueOn",
]);

function isOrderNumericSubstringField(searchField) {
  return ORDER_NUMERIC_SUBSTRING_FIELDS.has(String(searchField || "").trim());
}

function sqlColumn(alias, field) {
  return Prisma.raw(`${alias}."${field}"`);
}

function buildOrderSortSql(sortBy, sortOrder) {
  switch (sortBy) {
    case "customerName":
      return Prisma.sql`c."name" ${Prisma.raw(sortOrder)}`;
    case "manufacturerName":
      return Prisma.sql`m."name" ${Prisma.raw(sortOrder)}`;
    case "qualityName":
      return Prisma.sql`q."name" ${Prisma.raw(sortOrder)}`;
    default:
      return Prisma.sql`${sqlColumn("o", sortBy)} ${Prisma.raw(sortOrder)}`;
  }
}

function buildOrderRawWhereClauses({
  userId,
  selectedFinancialYearStart,
  customerId,
  manufacturerId,
  qualityId,
  fromDate,
  toDate,
  statusFilter,
  searchField,
  search,
}) {
  const clauses = [
    Prisma.sql`o."userId" = ${userId}`,
    Prisma.sql`o."fyStartYear" = ${selectedFinancialYearStart}`,
  ];

  if (customerId) {
    clauses.push(Prisma.sql`o."customerId" = ${customerId}`);
  }
  if (manufacturerId) {
    clauses.push(Prisma.sql`o."manufacturerId" = ${manufacturerId}`);
  }
  if (qualityId) {
    clauses.push(Prisma.sql`o."qualityId" = ${qualityId}`);
  }
  if (fromDate) {
    clauses.push(Prisma.sql`o."orderDate" >= ${fromDate}`);
  }
  if (toDate) {
    clauses.push(Prisma.sql`o."orderDate" <= ${toDate}`);
  }
  if (statusFilter) {
    clauses.push(Prisma.sql`o."status" = ${statusFilter}`);
  }

  const normalizedSearch = normalizeSearch(search);
  if (normalizedSearch) {
    const likePattern = `%${normalizedSearch}%`;
    const numericSearch = parseNumericSearchToken(normalizedSearch);

    if (isOrderNumericSubstringField(searchField)) {
      const field = String(searchField).trim();
      clauses.push(
        Prisma.sql`CAST(${sqlColumn("o", field)} AS TEXT) ILIKE ${likePattern}`
      );
    } else {
      const searchClause = buildOrderSearchWhere(searchField, normalizedSearch);
      if (searchClause) {
        // Fallback for non-numeric field searches stays in Prisma query path.
        clauses.push(Prisma.sql`TRUE`);
      }
    }
  }

  return clauses;
}

async function findOrderIdsByNumericSearch({
  userId,
  selectedFinancialYearStart,
  customerId,
  manufacturerId,
  qualityId,
  fromDate,
  toDate,
  statusFilter,
  searchField,
  search,
  sortBy,
  sortOrder,
  skip,
  take,
}) {
  const normalizedSearch = normalizeSearch(search);
  if (!normalizedSearch || !isOrderNumericSubstringField(searchField)) {
    return null;
  }

  const clauses = buildOrderRawWhereClauses({
    userId,
    selectedFinancialYearStart,
    customerId,
    manufacturerId,
    qualityId,
    fromDate,
    toDate,
    statusFilter,
    searchField,
    search: normalizedSearch,
  });

  const whereSql = Prisma.join(clauses, Prisma.sql` AND `);
  const orderSql = buildOrderSortSql(sortBy, sortOrder);
  const limitSql = skip === undefined || take === undefined ? Prisma.empty : Prisma.sql`LIMIT ${take} OFFSET ${skip}`;

  const ids = await prisma.$queryRaw`
    SELECT o."id"
    FROM "Order" o
    LEFT JOIN "Customer" c ON c."id" = o."customerId"
    LEFT JOIN "Manufacturer" m ON m."id" = o."manufacturerId"
    LEFT JOIN "Quality" q ON q."id" = o."qualityId"
    WHERE ${whereSql}
    ORDER BY ${orderSql}
    ${limitSql}
  `;

  const totalRows = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count
    FROM "Order" o
    LEFT JOIN "Customer" c ON c."id" = o."customerId"
    LEFT JOIN "Manufacturer" m ON m."id" = o."manufacturerId"
    LEFT JOIN "Quality" q ON q."id" = o."qualityId"
    WHERE ${whereSql}
  `;

  return {
    ids: ids.map((row) => row.id),
    total: totalRows[0]?.count || 0,
  };
}

const listOrders = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const selectedFinancialYearStart = await getSelectedFinancialYearStartForUser(userId);
  const pagination = parsePagination(req.query);
  const { sortBy, sortOrder } = parseSort(req.query, ORDER_SORT_FIELDS, "createdAt", "desc");
  const search = normalizeSearch(req.query.search);
  const searchWhere = buildOrderSearchWhere(req.query.searchField, search);
  const customerId = req.query.customerId ? String(req.query.customerId).trim() : null;
  const manufacturerId = req.query.manufacturerId ? String(req.query.manufacturerId).trim() : null;
  const qualityId = req.query.qualityId ? String(req.query.qualityId).trim() : null;
  const fromDate = req.query.from ? new Date(String(req.query.from)) : null;
  const toDate = req.query.to ? new Date(String(req.query.to)) : null;
  if (fromDate && Number.isNaN(fromDate.getTime())) {
    throw new AppError("invalid from date", 400);
  }
  if (toDate && Number.isNaN(toDate.getTime())) {
    throw new AppError("invalid to date", 400);
  }
  const statusFilter = req.query.status ? String(req.query.status).toUpperCase() : null;
  if (statusFilter && !Object.values(ORDER_STATUS).includes(statusFilter)) {
    throw new AppError("status must be one of: PENDING, COMPLETED, CANCELLED", 400);
  }
  const searchField = String(req.query.searchField || "").trim();
  const normalizedSearch = normalizeSearch(search);
  const useInMemoryNumericSubstringSearch =
    Boolean(normalizedSearch) && isOrderNumericSubstringField(searchField);

  const where = {
    userId,
    fyStartYear: selectedFinancialYearStart,
    ...(customerId ? { customerId } : {}),
    ...(manufacturerId ? { manufacturerId } : {}),
    ...(qualityId ? { qualityId } : {}),
    ...(fromDate || toDate
      ? {
          orderDate: {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          },
        }
      : {}),
    ...(statusFilter
      ? {
          status: statusFilter,
        }
      : {}),
    ...(!useInMemoryNumericSubstringSearch ? searchWhere || {} : {}),
  };

  const queryOptions = {
    where,
    orderBy: buildOrderSort(sortBy, sortOrder),
    include: {
      user: { select: { id: true, name: true, email: true } },
      customer: true,
      manufacturer: true,
      quality: true,
    },
  };

  if (useInMemoryNumericSubstringSearch) {
    const allOrders = await prisma.order.findMany(queryOptions);
    const filteredOrders = allOrders.filter((order) => {
      const fieldValue = order[searchField];
      if (fieldValue === null || fieldValue === undefined) {
        return false;
      }
      return String(fieldValue).includes(normalizedSearch);
    });
    const normalized = filteredOrders.map(normalizeOrder);

    if (!pagination.enabled) {
      return res.json(normalized);
    }

    const paginated = normalized.slice(pagination.skip, pagination.skip + pagination.take);
    return res.json(
      buildPaginatedResponse(paginated, normalized.length, pagination.page, pagination.limit)
    );
  }

  const orders = await prisma.order.findMany({
    ...queryOptions,
    skip: pagination.skip,
    take: pagination.take,
  });

  const normalized = orders.map(normalizeOrder);

  if (!pagination.enabled) {
    return res.json(normalized);
  }

  const total = await prisma.order.count({ where });
  return res.json(buildPaginatedResponse(normalized, total, pagination.page, pagination.limit));
});

const getOrderById = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  const order = await prisma.order.findFirst({
    where: { id, userId },
    include: {
      user: { select: { id: true, name: true, email: true } },
      customer: true,
      manufacturer: true,
      quality: true,
    },
  });

  if (!order) {
    throw new AppError("order not found", 404);
  }

  return res.json(normalizeOrder(order));
});

const updateOrder = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const {
    customerId,
    manufacturerId,
    rate,
    quantity,
    quantityUnit,
    lotMeters,
    qualityName,
    orderDate,
    remarks,
    customerRemark,
    manufacturerRemark,
    dyeingGuarantees,
    paymentDueOn,
    deliveryDateFrom,
    deliveryDateTo,
    processedQuantity,
    processedQuantityUnit,
    processedMeter,
    processedQuantityAdd,
    processedQuantityAddUnit,
    status,
    manufacturerFirmName,
  } =
    req.body;

  if (
    customerId === undefined &&
    manufacturerId === undefined &&
    rate === undefined &&
    quantity === undefined &&
    qualityName === undefined &&
    orderDate === undefined &&
    remarks === undefined &&
    customerRemark === undefined &&
    manufacturerRemark === undefined &&
    dyeingGuarantees === undefined &&
    paymentDueOn === undefined &&
    deliveryDateFrom === undefined &&
    deliveryDateTo === undefined &&
    quantityUnit === undefined &&
    lotMeters === undefined &&
    processedQuantity === undefined &&
    processedMeter === undefined &&
    processedQuantityAdd === undefined &&
    processedQuantityAddUnit === undefined &&
    status === undefined &&
    manufacturerFirmName === undefined
  ) {
    throw new AppError("at least one field is required to update order", 400);
  }

  if (quantity !== undefined && Number(quantity) <= 0) {
    throw new AppError("quantity must be greater than 0", 400);
  }

  if (rate !== undefined && Number(rate) <= 0) {
    throw new AppError("rate must be greater than 0", 400);
  }

  if (quantityUnit !== undefined && !Object.values(QUANTITY_UNITS).includes(quantityUnit)) {
    throw new AppError("quantityUnit must be one of: TAKKA, LOT, METER", 400);
  }

  const requestedQuantityUnit = quantityUnit !== undefined ? quantityUnit : undefined;
  const parsedLotMeters = parseLotMetersInput(lotMeters, requestedQuantityUnit);

  if (
    paymentDueOn !== undefined &&
    (!Number.isInteger(Number(paymentDueOn)) || Number(paymentDueOn) < 0)
  ) {
    throw new AppError("paymentDueOn must be a whole number of days and cannot be negative", 400);
  }
  if (
    processedQuantity !== undefined &&
    (!Number.isFinite(Number(processedQuantity)) || Number(processedQuantity) < 0)
  ) {
    throw new AppError("processedQuantity must be a number and cannot be negative", 400);
  }
  if (
    processedMeter !== undefined &&
    (!Number.isFinite(Number(processedMeter)) || Number(processedMeter) < 0)
  ) {
    throw new AppError("processedMeter must be a number and cannot be negative", 400);
  }
  if (
    processedQuantityUnit !== undefined &&
    !Object.values(QUANTITY_UNITS).includes(String(processedQuantityUnit).toUpperCase())
  ) {
    throw new AppError("processedQuantityUnit must be one of: TAKKA, LOT, METER", 400);
  }
  if (
    processedQuantityAdd !== undefined &&
    (!Number.isFinite(Number(processedQuantityAdd)) || Number(processedQuantityAdd) < 0)
  ) {
    throw new AppError("processedQuantityAdd must be a number and cannot be negative", 400);
  }
  if (processedQuantityAddUnit !== undefined) {
    const normalizedProcessedUnit = String(processedQuantityAddUnit).toUpperCase();
    if (!Object.values(QUANTITY_UNITS).includes(normalizedProcessedUnit)) {
      throw new AppError("processedQuantityAddUnit must be one of: TAKKA, LOT, METER", 400);
    }
  }
  if (processedQuantity !== undefined && processedQuantityAdd !== undefined) {
    throw new AppError("provide either processedQuantity or processedQuantityAdd, not both", 400);
  }
  if (processedQuantityAddUnit !== undefined && processedQuantityAdd === undefined) {
    throw new AppError("processedQuantityAddUnit requires processedQuantityAdd", 400);
  }
  if (
    status !== undefined &&
    !Object.values(ORDER_STATUS).includes(String(status).toUpperCase())
  ) {
    throw new AppError("status must be one of: PENDING, COMPLETED, CANCELLED", 400);
  }
  if (
    deliveryDateFrom !== undefined &&
    deliveryDateFrom !== null &&
    deliveryDateFrom !== "" &&
    Number.isNaN(new Date(deliveryDateFrom).getTime())
  ) {
    throw new AppError("deliveryDateFrom is invalid", 400);
  }
  if (
    deliveryDateTo !== undefined &&
    deliveryDateTo !== null &&
    deliveryDateTo !== "" &&
    Number.isNaN(new Date(deliveryDateTo).getTime())
  ) {
    throw new AppError("deliveryDateTo is invalid", 400);
  }

  let order;
  for (let attempt = 0; attempt < ORDER_NO_RETRY_LIMIT; attempt += 1) {
    try {
      order = await prisma.$transaction(async (tx) => {
        const existing = await tx.order.findFirst({
          where: { id, userId },
          select: {
            id: true,
            customerId: true,
            manufacturerId: true,
            rate: true,
            quantity: true,
            quantityUnit: true,
            lotMeters: true,
            meter: true,
            processedQuantity: true,
            processedMeter: true,
            deliveryDateFrom: true,
            deliveryDateTo: true,
            status: true,
            fyStartYear: true,
            customer: {
              select: {
                commissionBase: true,
                commissionPercent: true,
                commissionLotRate: true,
              },
            },
          },
        });
        if (!existing) {
          throw new AppError("order not found", 404);
        }

        const updateData = {};
        let customerForCommission = null;

        if (customerId !== undefined) {
          const customer = await tx.customer.findFirst({
            where: { id: customerId, userId },
            select: {
              id: true,
              commissionBase: true,
              commissionPercent: true,
              commissionLotRate: true,
            },
          });
          if (!customer) {
            throw new AppError("customer not found", 404);
          }
          updateData.customerId = customerId;
          customerForCommission = customer;
        }
        if (manufacturerId !== undefined) {
          const manufacturer = await tx.manufacturer.findFirst({
            where: { id: manufacturerId, userId },
            select: { id: true },
          });
          if (!manufacturer) {
            throw new AppError("manufacturer not found", 404);
          }
          updateData.manufacturerId = manufacturerId;
        }
        if (manufacturerFirmName !== undefined) {
          const firmName = String(manufacturerFirmName || "").trim();
          await tx.manufacturer.update({
            where: { id: existing.manufacturerId },
            data: { firmName: firmName || null },
          });
        }
        if (rate !== undefined) {
          updateData.rate = round2(Number(rate));
        }
        if (quantity !== undefined) {
          updateData.quantity = Number(quantity);
        }
        if (orderDate !== undefined) {
          const parsedOrderDate = parseOrderDateOrThrow(orderDate);
          const nextFyStartYear = getFinancialYearStartYear(parsedOrderDate);
          updateData.orderDate = parsedOrderDate;

          if (nextFyStartYear !== existing.fyStartYear) {
            updateData.fyStartYear = nextFyStartYear;
            updateData.orderNo = await getNextOrderNo(tx, userId, nextFyStartYear);
          }
        }
        if (qualityName !== undefined) {
          updateData.qualityId = await resolveQualityId(tx, userId, qualityName);
        }
        if (remarks !== undefined) {
          updateData.remarks = remarks?.trim() || null;
        }
        if (customerRemark !== undefined) {
          updateData.customerRemark = customerRemark?.trim() || null;
        }
        if (manufacturerRemark !== undefined) {
          updateData.manufacturerRemark = manufacturerRemark?.trim() || null;
        }
        if (dyeingGuarantees !== undefined) {
          updateData.dyeingGuarantees = Boolean(dyeingGuarantees);
        }
        if (paymentDueOn !== undefined) {
          updateData.paymentDueOn = paymentDueOn === null ? null : Number(paymentDueOn);
        }
        const nextDeliveryDateFrom =
          deliveryDateFrom !== undefined
            ? parseOptionalDateOrThrow(deliveryDateFrom, "deliveryDateFrom")
            : existing.deliveryDateFrom;
        const nextDeliveryDateTo =
          deliveryDateTo !== undefined
            ? parseOptionalDateOrThrow(deliveryDateTo, "deliveryDateTo")
            : existing.deliveryDateTo;
        if (nextDeliveryDateFrom && nextDeliveryDateTo && nextDeliveryDateFrom > nextDeliveryDateTo) {
          throw new AppError("deliveryDateFrom cannot be after deliveryDateTo", 400);
        }
        if (deliveryDateFrom !== undefined) {
          updateData.deliveryDateFrom = nextDeliveryDateFrom;
        }
        if (deliveryDateTo !== undefined) {
          updateData.deliveryDateTo = nextDeliveryDateTo;
        }
        if (status !== undefined) {
          updateData.status = String(status).toUpperCase();
        }

        const shouldRecalculateAmounts =
          rate !== undefined ||
          quantity !== undefined ||
          quantityUnit !== undefined ||
          lotMeters !== undefined ||
          customerId !== undefined;
        if (shouldRecalculateAmounts) {
          const currentOrder = await tx.order.findFirst({
            where: { id, userId },
            select: {
              rate: true,
              quantity: true,
              quantityUnit: true,
              lotMeters: true,
              meter: true,
              customer: {
                select: {
                  commissionBase: true,
                  commissionPercent: true,
                  commissionLotRate: true,
                },
              },
            },
          });
          if (!currentOrder) {
            throw new AppError("order not found", 404);
          }
          const commissionConfig = customerForCommission || currentOrder.customer;
          const effectiveQuantityUnitForAmounts =
            quantityUnit !== undefined ? quantityUnit : currentOrder.quantityUnit;
          const amountData = computeOrderAmounts(
            quantity !== undefined ? Number(quantity) : Number(currentOrder.quantity),
            rate !== undefined ? Number(rate) : Number(currentOrder.rate),
            effectiveQuantityUnitForAmounts,
            commissionConfig,
            parsedLotMeters !== undefined ? parsedLotMeters : currentOrder.lotMeters
          );
          updateData.quantityUnit = amountData.quantityUnit;
          updateData.lotMeters = amountData.lotMeters;
          updateData.lot = amountData.lot;
          updateData.meter = amountData.meter;
        }

        const effectiveQuantityUnit = updateData.quantityUnit || existing.quantityUnit;
        const effectiveLotMeters = Number(
          updateData.lotMeters !== undefined ? updateData.lotMeters : existing.lotMeters
        );
        const existingProcessedQuantity = Number(existing.processedQuantity || 0);
        const existingProcessedMeter = Number(existing.processedMeter || 0);
        const effectiveProcessedQuantityUnit =
          processedQuantityUnit !== undefined
            ? String(processedQuantityUnit).toUpperCase()
            : effectiveQuantityUnit;

        if (processedMeter !== undefined) {
          const nextProcessedMeter = Number(processedMeter);
          updateData.processedMeter = round2(nextProcessedMeter);
          updateData.processedQuantity = round2(
            toQuantityFromMeter({
              meter: nextProcessedMeter,
              quantityUnit: effectiveQuantityUnit,
              lotMeters: effectiveLotMeters,
            })
          );
        } else if (processedQuantity !== undefined) {
          const nextProcessedQuantity = Number(processedQuantity);
          const nextProcessedMeter =
            effectiveProcessedQuantityUnit === QUANTITY_UNITS.METER
              ? nextProcessedQuantity
              : toMeterFromQuantity({
                  quantity: nextProcessedQuantity,
                  quantityUnit: effectiveProcessedQuantityUnit,
                  lotMeters: effectiveLotMeters,
                });
          updateData.processedQuantity = round2(
            convertQuantityToOrderUnit({
              quantity: nextProcessedQuantity,
              inputUnit: effectiveProcessedQuantityUnit,
              orderUnit: effectiveQuantityUnit,
              lotMeters: effectiveLotMeters,
            })
          );
          updateData.processedMeter = round2(nextProcessedMeter);
        }

        if (processedQuantityAdd !== undefined) {
          const processedAddValue = Number(processedQuantityAdd);
          const processedAddUnit = String(
            processedQuantityAddUnit || effectiveProcessedQuantityUnit || effectiveQuantityUnit
          ).toUpperCase();

          const quantityIncrement = convertQuantityToOrderUnit({
            quantity: processedAddValue,
            inputUnit: processedAddUnit,
            orderUnit: effectiveQuantityUnit,
            lotMeters: effectiveLotMeters,
          });
          const meterIncrement =
            processedAddUnit === QUANTITY_UNITS.METER
              ? processedAddValue
              : toMeterFromQuantity({
                  quantity: processedAddValue,
                  quantityUnit: processedAddUnit,
                  lotMeters: effectiveLotMeters,
                });

          updateData.processedQuantity = round2(existingProcessedQuantity + quantityIncrement);
          updateData.processedMeter = round2(existingProcessedMeter + meterIncrement);
        }

        if (
          quantityUnit !== undefined &&
          processedQuantity === undefined &&
          processedQuantityAdd === undefined
        ) {
          updateData.processedMeter = round2(existingProcessedMeter);
          updateData.processedQuantity = round2(
            toQuantityFromMeter({
              meter: existingProcessedMeter,
              quantityUnit: effectiveQuantityUnit,
              lotMeters: effectiveLotMeters,
            })
          );
        }

        const effectiveQuantity = Number(
          updateData.quantity !== undefined ? updateData.quantity : existing.quantity
        );
        const effectiveMeter = Number(
          updateData.meter !== undefined ? updateData.meter : existing.meter
        );

        if (
          updateData.status === ORDER_STATUS.COMPLETED &&
          processedQuantity === undefined &&
          processedMeter === undefined &&
          processedQuantityAdd === undefined
        ) {
          updateData.processedQuantity = round2(effectiveQuantity);
          updateData.processedMeter =
            Number.isFinite(effectiveMeter) && effectiveMeter > 0
              ? round2(effectiveMeter)
              : round2(
                  toMeterFromQuantity({
                    quantity: effectiveQuantity,
                    quantityUnit: effectiveQuantityUnit,
                    lotMeters: effectiveLotMeters,
                  })
                );
        }

        const shouldRefreshLiveCommission =
          rate !== undefined ||
          quantity !== undefined ||
          quantityUnit !== undefined ||
          lotMeters !== undefined ||
          customerId !== undefined ||
          processedQuantity !== undefined ||
          processedMeter !== undefined ||
          processedQuantityAdd !== undefined ||
          updateData.status === ORDER_STATUS.COMPLETED;
        if (shouldRefreshLiveCommission) {
          const commissionSourceOrder = {
            ...existing,
            ...updateData,
            customer: customerForCommission || existing.customer,
          };
          updateData.commissionAmount = computeLiveProgressCommissionAmount(commissionSourceOrder);
        }

        const updatedOrder = await tx.order.update({
          where: { id },
          data: updateData,
          include: {
            user: { select: { id: true, name: true, email: true } },
            customer: true,
            manufacturer: true,
            quality: true,
          },
        });

        await syncPendingPaymentForOrder(tx, updatedOrder);

        const beforeSnapshot = buildOrderAuditSnapshot(existing);
        const afterSnapshot = buildOrderAuditSnapshot(updatedOrder);
        const changedFields = getChangedFields(beforeSnapshot, afterSnapshot);
        const activityAction = resolveOrderActivityAction(existing.status, updatedOrder.status, updateData);

        await recordOrderActivity(tx, {
          userId,
          orderId: updatedOrder.id,
          action: activityAction,
          beforeData: beforeSnapshot,
          afterData: afterSnapshot,
          metadata: {
            changedFields,
          },
        });

        return updatedOrder;
      });
      break;
    } catch (error) {
      if (isOrderNoUniqueConflict(error) && attempt < ORDER_NO_RETRY_LIMIT - 1) {
        continue;
      }
      throw error;
    }
  }

  return res.json(normalizeOrder(order));
});

const getOrderActivity = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  const activities = await prisma.orderActivity.findMany({
    where: {
      userId,
      orderId: id,
    },
    orderBy: [{ createdAt: "desc" }],
    include: {
      user: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  return res.json(
    activities.map((activity) => ({
      id: activity.id,
      action: activity.action,
      beforeData: activity.beforeData,
      afterData: activity.afterData,
      metadata: activity.metadata,
      createdAt: activity.createdAt,
      user: activity.user,
    }))
  );
});

const ORDER_ACTIVITY_SORT_FIELDS = ["createdAt", "action"];

const ORDER_ACTIVITY_SEARCH_FIELDS = {
  ORDER_NO: "orderNo",
  ACTION: "action",
  CUSTOMER_NAME: "customerName",
  CUSTOMER_FIRM_NAME: "customerFirmName",
  MANUFACTURER_NAME: "manufacturerName",
  MANUFACTURER_FIRM_NAME: "manufacturerFirmName",
  QUALITY_NAME: "qualityName",
};

function isOrderActivityNumericSubstringField(field) {
  return String(field || "").trim() === ORDER_ACTIVITY_SEARCH_FIELDS.ORDER_NO;
}

function matchesActivitySearch(activity, searchField, search) {
  const normalizedSearch = normalizeSearch(search);
  if (!normalizedSearch) {
    return true;
  }

  const field = String(searchField || "").trim();
  const lowerSearch = normalizedSearch.toLowerCase();
  const orderNo = activity.order?.orderNo;

  const customerName = activity.order?.customer?.name || "";
  const customerFirmName = activity.order?.customer?.firmName || "";
  const manufacturerName = activity.order?.manufacturer?.name || "";
  const manufacturerFirmName = activity.order?.manufacturer?.firmName || "";
  const qualityName = activity.order?.quality?.name || "";
  const action = activity.action || "";
  const changedFields = Array.isArray(activity.metadata?.changedFields)
    ? activity.metadata.changedFields.map((value) => String(value || "").toLowerCase())
    : [];

  if (field === ORDER_ACTIVITY_SEARCH_FIELDS.ORDER_NO) {
    return String(orderNo || "").includes(normalizedSearch);
  }
  if (field === ORDER_ACTIVITY_SEARCH_FIELDS.ACTION) {
    return action.toLowerCase().includes(lowerSearch);
  }
  if (field === ORDER_ACTIVITY_SEARCH_FIELDS.CUSTOMER_NAME) {
    return customerName.toLowerCase().includes(lowerSearch) || customerFirmName.toLowerCase().includes(lowerSearch);
  }
  if (field === ORDER_ACTIVITY_SEARCH_FIELDS.CUSTOMER_FIRM_NAME) {
    return customerFirmName.toLowerCase().includes(lowerSearch);
  }
  if (field === ORDER_ACTIVITY_SEARCH_FIELDS.MANUFACTURER_NAME) {
    return (
      manufacturerName.toLowerCase().includes(lowerSearch) ||
      manufacturerFirmName.toLowerCase().includes(lowerSearch)
    );
  }
  if (field === ORDER_ACTIVITY_SEARCH_FIELDS.MANUFACTURER_FIRM_NAME) {
    return manufacturerFirmName.toLowerCase().includes(lowerSearch);
  }
  if (field === ORDER_ACTIVITY_SEARCH_FIELDS.QUALITY_NAME) {
    return qualityName.toLowerCase().includes(lowerSearch);
  }

  return (
    action.toLowerCase().includes(lowerSearch) ||
    String(orderNo || "").includes(normalizedSearch) ||
    customerName.toLowerCase().includes(lowerSearch) ||
    customerFirmName.toLowerCase().includes(lowerSearch) ||
    manufacturerName.toLowerCase().includes(lowerSearch) ||
    manufacturerFirmName.toLowerCase().includes(lowerSearch) ||
    qualityName.toLowerCase().includes(lowerSearch) ||
    changedFields.some((fieldName) => fieldName.includes(lowerSearch))
  );
}

const listOrderActivities = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const selectedFinancialYearStart = await getSelectedFinancialYearStartForUser(userId);
  const pagination = parsePagination(req.query);
  const { sortBy, sortOrder } = parseSort(req.query, ORDER_ACTIVITY_SORT_FIELDS, "createdAt", "desc");
  const search = normalizeSearch(req.query.search);
  const searchField = String(req.query.searchField || "").trim();
  const actionFilter = req.query.action ? String(req.query.action).trim().toUpperCase() : null;
  const orderNoFilter = req.query.orderNo ? Number.parseInt(String(req.query.orderNo), 10) : null;
  const fromDate = req.query.from ? new Date(String(req.query.from)) : null;
  const toDate = req.query.to ? new Date(String(req.query.to)) : null;

  if (fromDate && Number.isNaN(fromDate.getTime())) {
    throw new AppError("invalid from date", 400);
  }
  if (toDate && Number.isNaN(toDate.getTime())) {
    throw new AppError("invalid to date", 400);
  }
  if (orderNoFilter !== null && !Number.isFinite(orderNoFilter)) {
    throw new AppError("orderNo must be a valid number", 400);
  }
  const activities = await prisma.orderActivity.findMany({
    where: { userId },
    orderBy: [{ [sortBy]: sortOrder }],
    include: {
      user: {
        select: { id: true, name: true, email: true },
      },
      order: {
        include: {
          customer: true,
          manufacturer: true,
          quality: true,
        },
      },
    },
  });

  const filtered = activities.filter((activity) => {
    if (activity.order?.fyStartYear !== selectedFinancialYearStart) {
      return false;
    }
    if (actionFilter && String(activity.action || "").toUpperCase() !== actionFilter) {
      return false;
    }
    if (fromDate && activity.createdAt < fromDate) {
      return false;
    }
    if (toDate && activity.createdAt > toDate) {
      return false;
    }
    if (orderNoFilter !== null && activity.order?.orderNo !== orderNoFilter) {
      return false;
    }
    return matchesActivitySearch(activity, searchField, search);
  });

  const normalized = filtered.map((activity) => ({
    id: activity.id,
    action: activity.action,
    beforeData: activity.beforeData,
    afterData: activity.afterData,
    metadata: activity.metadata,
    createdAt: activity.createdAt,
    user: activity.user,
    order: activity.order,
  }));

  if (!pagination.enabled) {
    return res.json(normalized);
  }

  const paginated = normalized.slice(pagination.skip, pagination.skip + pagination.take);
  return res.json(buildPaginatedResponse(paginated, normalized.length, pagination.page, pagination.limit));
});

const deleteOrder = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  const deleted = await prisma.$transaction(async (tx) => {
    const existing = await tx.order.findFirst({
      where: { id, userId },
      include: {
        customer: true,
        manufacturer: true,
        quality: true,
      },
    });

    if (!existing) {
      return null;
    }

    await recordOrderActivity(tx, {
      userId,
      orderId: existing.id,
      action: ORDER_ACTIVITY_ACTIONS.DELETED,
      beforeData: buildOrderAuditSnapshot(existing),
      afterData: null,
    });

    const result = await tx.order.deleteMany({ where: { id, userId } });
    return result.count > 0 ? existing : null;
  });

  if (!deleted) {
    throw new AppError("order not found", 404);
  }
  return res.status(204).send();
});

module.exports = {
  createOrder,
  listOrders,
  getOrderById,
  getOrderActivity,
  listOrderActivities,
  updateOrder,
  deleteOrder,
};
