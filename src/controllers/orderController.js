const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const { buildOrderWhatsAppLinks } = require("../utils/whatsapp");
const {
  buildPaginatedResponse,
  normalizeSearch,
  parsePagination,
  parseSort,
} = require("../utils/listQuery");

function normalizeOrder(order) {
  const processedQuantity = Number(order.processedQuantity || 0);
  const progressCommissionAmount = computeCommissionAmount({
    quantityForCommission: processedQuantity,
    rate: Number(order.rate),
    quantityUnit: order.quantityUnit,
    lotMeters: Number(order.lotMeters || 0),
    customerCommissionConfig: order.customer,
  });

  return {
    ...order,
    processedQuantity,
    rate: Number(order.rate),
    lotMeters: order.lotMeters === null ? null : Number(order.lotMeters),
    meter: order.meter === null ? null : Number(order.meter),
    commissionAmount: order.commissionAmount === null ? null : Number(order.commissionAmount),
    progressCommissionAmount,
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
const LOT_MIN_METERS = 1450;
const LOT_MAX_METERS = 1550;
const GST_RATE = 0.05;
const DEFAULT_COMMISSION_PERCENT = 1;

function getRandomLotMeters() {
  return LOT_MIN_METERS + Math.random() * (LOT_MAX_METERS - LOT_MIN_METERS);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function toMeterFromQuantity({ quantity, quantityUnit, lotMeters }) {
  if (quantityUnit === QUANTITY_UNITS.METER) {
    return quantity;
  }
  if (quantityUnit === QUANTITY_UNITS.LOT) {
    return quantity * lotMeters;
  }
  return quantity * (lotMeters / TAKKA_PER_LOT);
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
    return round2(quantityForCommission * commissionLotRate);
  }

  const meter = toMeterFromQuantity({
    quantity: quantityForCommission,
    quantityUnit,
    lotMeters,
  });
  const baseAmount = meter * rate;
  const gstAmount = baseAmount * GST_RATE;
  return round2((baseAmount + gstAmount) * (commissionPercent / 100));
}

function computeOrderAmounts(quantity, rate, quantityUnit, customerCommissionConfig) {
  const normalizedUnit = Object.values(QUANTITY_UNITS).includes(quantityUnit)
    ? quantityUnit
    : QUANTITY_UNITS.TAKKA;

  const lotMeters =
    normalizedUnit === QUANTITY_UNITS.METER ? null : getRandomLotMeters();

  const meter =
    normalizedUnit === QUANTITY_UNITS.METER
      ? quantity
      : toMeterFromQuantity({ quantity, quantityUnit: normalizedUnit, lotMeters });
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
    meter: round2(meter),
    commissionAmount: round2(commissionAmount),
  };
}

async function resolveQualityId(tx, userId, qualityName) {
  const normalized = qualityName?.trim();
  if (!normalized) {
    throw new AppError("qualityName is required", 400);
  }

  const existing = await tx.quality.findFirst({
    where: { userId, name: normalized },
    select: { id: true },
  });

  if (existing) {
    return existing.id;
  }

  const created = await tx.quality.create({
    data: { userId, name: normalized },
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
    qualityName,
    orderDate,
    remarks,
    paymentDueOn,
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

  if (
    paymentDueOn !== undefined &&
    (!Number.isInteger(Number(paymentDueOn)) || Number(paymentDueOn) < 0)
  ) {
    throw new AppError("paymentDueOn must be a whole number of days and cannot be negative", 400);
  }

  const order = await prisma.$transaction(async (tx) => {
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
    const amountData = computeOrderAmounts(Number(quantity), Number(rate), quantityUnit, customer);
    const userCounter = await tx.user.update({
      where: { id: userId },
      data: { orderCounter: { increment: 1 } },
      select: { orderCounter: true },
    });

    return tx.order.create({
      data: {
        userId,
        orderNo: userCounter.orderCounter,
        customerId,
        manufacturerId,
        qualityId,
        rate,
        quantity: Number(quantity),
        processedQuantity: 0,
        status: ORDER_STATUS.PENDING,
        quantityUnit: amountData.quantityUnit,
        lotMeters: amountData.lotMeters,
        meter: amountData.meter,
        commissionAmount: amountData.commissionAmount,
        remarks: remarks?.trim() || null,
        paymentDueOn: paymentDueOn !== undefined ? Number(paymentDueOn) : null,
        orderDate: new Date(orderDate),
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        customer: true,
        manufacturer: true,
        quality: true,
      },
    });
  });

  return res.status(201).json(normalizeOrder(order));
});

const ORDER_SORT_FIELDS = [
  "orderNo",
  "status",
  "orderDate",
  "rate",
  "quantity",
  "processedQuantity",
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

const listOrders = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const pagination = parsePagination(req.query);
  const { sortBy, sortOrder } = parseSort(req.query, ORDER_SORT_FIELDS, "createdAt", "desc");
  const search = normalizeSearch(req.query.search);
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
  const orderNoSearch = Number.parseInt(search || "", 10);
  const hasOrderNoSearch = Number.isFinite(orderNoSearch);
  const searchAsStatus = search ? String(search).toUpperCase() : null;
  const hasStatusSearch = searchAsStatus && Object.values(ORDER_STATUS).includes(searchAsStatus);
  const searchConditions = [];
  if (search) {
    if (hasOrderNoSearch) {
      searchConditions.push({ orderNo: orderNoSearch });
    }
    if (hasStatusSearch) {
      searchConditions.push({ status: searchAsStatus });
    }
    searchConditions.push({ customer: { name: { contains: search, mode: "insensitive" } } });
    searchConditions.push({ manufacturer: { name: { contains: search, mode: "insensitive" } } });
    searchConditions.push({ manufacturer: { firmName: { contains: search, mode: "insensitive" } } });
    searchConditions.push({ quality: { name: { contains: search, mode: "insensitive" } } });
    searchConditions.push({ remarks: { contains: search, mode: "insensitive" } });
  }

  const where = {
    userId,
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
    ...(searchConditions.length
      ? {
        OR: searchConditions,
      }
      : {}),
  };

  const orders = await prisma.order.findMany({
    where,
    orderBy: buildOrderSort(sortBy, sortOrder),
    skip: pagination.skip,
    take: pagination.take,
    include: {
      user: { select: { id: true, name: true, email: true } },
      customer: true,
      manufacturer: true,
      quality: true,
    },
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
    qualityName,
    orderDate,
    remarks,
    paymentDueOn,
    processedQuantity,
    processedQuantityAdd,
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
    paymentDueOn === undefined &&
    quantityUnit === undefined &&
    processedQuantity === undefined &&
    processedQuantityAdd === undefined &&
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

  if (
    paymentDueOn !== undefined &&
    (!Number.isInteger(Number(paymentDueOn)) || Number(paymentDueOn) < 0)
  ) {
    throw new AppError("paymentDueOn must be a whole number of days and cannot be negative", 400);
  }
  if (
    processedQuantity !== undefined &&
    (!Number.isInteger(Number(processedQuantity)) || Number(processedQuantity) < 0)
  ) {
    throw new AppError("processedQuantity must be a whole number and cannot be negative", 400);
  }
  if (
    processedQuantityAdd !== undefined &&
    (!Number.isInteger(Number(processedQuantityAdd)) || Number(processedQuantityAdd) < 0)
  ) {
    throw new AppError("processedQuantityAdd must be a whole number and cannot be negative", 400);
  }
  if (processedQuantity !== undefined && processedQuantityAdd !== undefined) {
    throw new AppError("provide either processedQuantity or processedQuantityAdd, not both", 400);
  }
  if (
    status !== undefined &&
    !Object.values(ORDER_STATUS).includes(String(status).toUpperCase())
  ) {
    throw new AppError("status must be one of: PENDING, COMPLETED, CANCELLED", 400);
  }

  const order = await prisma.$transaction(async (tx) => {
    const existing = await tx.order.findFirst({
      where: { id, userId },
      select: {
        id: true,
        manufacturerId: true,
        quantity: true,
        processedQuantity: true,
        status: true,
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
      updateData.rate = rate;
    }
    if (quantity !== undefined) {
      updateData.quantity = Number(quantity);
    }
    if (orderDate !== undefined) {
      updateData.orderDate = new Date(orderDate);
    }
    if (qualityName !== undefined) {
      updateData.qualityId = await resolveQualityId(tx, userId, qualityName);
    }
    if (remarks !== undefined) {
      updateData.remarks = remarks?.trim() || null;
    }
    if (paymentDueOn !== undefined) {
      updateData.paymentDueOn = paymentDueOn === null ? null : Number(paymentDueOn);
    }
    if (processedQuantity !== undefined) {
      const normalizedProcessedQuantity = Number(processedQuantity);
      updateData.processedQuantity = normalizedProcessedQuantity;
    }
    if (processedQuantityAdd !== undefined) {
      const normalizedProcessedQuantityAdd = Number(processedQuantityAdd);
      updateData.processedQuantity =
        Number(existing.processedQuantity) + normalizedProcessedQuantityAdd;
    }
    if (status !== undefined) {
      updateData.status = String(status).toUpperCase();
    }

    const shouldRecalculateAmounts =
      rate !== undefined || quantity !== undefined || quantityUnit !== undefined || customerId !== undefined;
    if (shouldRecalculateAmounts) {
      const currentOrder = await tx.order.findFirst({
        where: { id, userId },
        select: {
          rate: true,
          quantity: true,
          quantityUnit: true,
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
      const amountData = computeOrderAmounts(
        quantity !== undefined ? Number(quantity) : Number(currentOrder.quantity),
        rate !== undefined ? Number(rate) : Number(currentOrder.rate),
        quantityUnit !== undefined ? quantityUnit : currentOrder.quantityUnit,
        commissionConfig
      );
      updateData.quantityUnit = amountData.quantityUnit;
      updateData.lotMeters = amountData.lotMeters;
      updateData.meter = amountData.meter;
      updateData.commissionAmount = amountData.commissionAmount;
    }

    const shouldFinalizeCommission =
      updateData.status === ORDER_STATUS.COMPLETED ||
      (processedQuantity !== undefined && existing.status === ORDER_STATUS.COMPLETED);
    const shouldFinalizeCommissionFromAdd =
      processedQuantityAdd !== undefined && existing.status === ORDER_STATUS.COMPLETED;
    if (shouldFinalizeCommission || shouldFinalizeCommissionFromAdd) {
      const orderSnapshot = await tx.order.findFirst({
        where: { id, userId },
        select: {
          rate: true,
          quantityUnit: true,
          lotMeters: true,
          processedQuantity: true,
          customer: {
            select: {
              commissionBase: true,
              commissionPercent: true,
              commissionLotRate: true,
            },
          },
        },
      });
      if (!orderSnapshot) {
        throw new AppError("order not found", 404);
      }
      const commissionConfig = customerForCommission || orderSnapshot.customer;
      const finalProcessedQuantity =
        processedQuantity !== undefined
          ? Number(processedQuantity)
          : processedQuantityAdd !== undefined
          ? Number(existing.processedQuantity) + Number(processedQuantityAdd)
          : Number(orderSnapshot.processedQuantity);

      updateData.commissionAmount = computeCommissionAmount({
        quantityForCommission: finalProcessedQuantity,
        rate: Number(updateData.rate ?? orderSnapshot.rate),
        quantityUnit: updateData.quantityUnit ?? orderSnapshot.quantityUnit,
        lotMeters:
          updateData.lotMeters !== undefined
            ? Number(updateData.lotMeters || 0)
            : Number(orderSnapshot.lotMeters || 0),
        customerCommissionConfig: commissionConfig,
      });
    }

    return tx.order.update({
      where: { id },
      data: updateData,
      include: {
        user: { select: { id: true, name: true, email: true } },
        customer: true,
        manufacturer: true,
        quality: true,
      },
    });
  });

  return res.json(normalizeOrder(order));
});

const deleteOrder = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const deleted = await prisma.order.deleteMany({ where: { id, userId } });
  if (deleted.count === 0) {
    throw new AppError("order not found", 404);
  }
  return res.status(204).send();
});

module.exports = {
  createOrder,
  listOrders,
  getOrderById,
  updateOrder,
  deleteOrder,
};
