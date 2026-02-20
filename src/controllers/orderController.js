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
  return {
    ...order,
    rate: Number(order.rate),
    lotMeters: order.lotMeters === null ? null : Number(order.lotMeters),
    meter: order.meter === null ? null : Number(order.meter),
    commissionAmount: order.commissionAmount === null ? null : Number(order.commissionAmount),
    whatsappLinks: buildOrderWhatsAppLinks(order),
  };
}

const QUANTITY_UNITS = {
  TAKKA: "TAKKA",
  LOT: "LOT",
  METER: "METER",
};
const TAKKA_PER_LOT = 12;
const LOT_MIN_METERS = 1450;
const LOT_MAX_METERS = 1550;
const GST_RATE = 0.05;
const COMMISSION_RATE = 0.01;

function getRandomLotMeters() {
  return LOT_MIN_METERS + Math.random() * (LOT_MAX_METERS - LOT_MIN_METERS);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function computeOrderAmounts(quantity, rate, quantityUnit) {
  const normalizedUnit = Object.values(QUANTITY_UNITS).includes(quantityUnit)
    ? quantityUnit
    : QUANTITY_UNITS.TAKKA;

  const lotMeters =
    normalizedUnit === QUANTITY_UNITS.METER ? null : getRandomLotMeters();

  const meter = normalizedUnit === QUANTITY_UNITS.METER
    ? quantity
    : normalizedUnit === QUANTITY_UNITS.LOT
    ? quantity * lotMeters
    : quantity * (lotMeters / TAKKA_PER_LOT);

  const baseAmount = meter * rate;
  const gstAmount = baseAmount * GST_RATE;
  const commissionAmount = (baseAmount + gstAmount) * COMMISSION_RATE;

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
      tx.customer.findFirst({ where: { id: customerId, userId }, select: { id: true } }),
      tx.manufacturer.findFirst({ where: { id: manufacturerId, userId }, select: { id: true } }),
    ]);

    if (!customer) {
      throw new AppError("customer not found", 404);
    }
    if (!manufacturer) {
      throw new AppError("manufacturer not found", 404);
    }

    const qualityId = await resolveQualityId(tx, userId, qualityName);
    const amountData = computeOrderAmounts(Number(quantity), Number(rate), quantityUnit);

    return tx.order.create({
      data: {
        userId,
        customerId,
        manufacturerId,
        qualityId,
        rate,
        quantity: Number(quantity),
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
  "orderDate",
  "rate",
  "quantity",
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
  const orderNoSearch = Number.parseInt(search || "", 10);
  const hasOrderNoSearch = Number.isFinite(orderNoSearch);

  const where = {
    userId,
    ...(search
      ? {
        OR: [
          ...(hasOrderNoSearch ? [{ orderNo: orderNoSearch }] : []),
          { customer: { is: { name: { contains: search, mode: "insensitive" } } } },
          { customer: { is: { gstNo: { contains: search, mode: "insensitive" } } } },
          { manufacturer: { is: { name: { contains: search, mode: "insensitive" } } } },
          { quality: { is: { name: { contains: search, mode: "insensitive" } } } },
        ],
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
    quantityUnit === undefined
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

  const order = await prisma.$transaction(async (tx) => {
    const existing = await tx.order.findFirst({ where: { id, userId }, select: { id: true } });
    if (!existing) {
      throw new AppError("order not found", 404);
    }

    const updateData = {};

    if (customerId !== undefined) {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, userId },
        select: { id: true },
      });
      if (!customer) {
        throw new AppError("customer not found", 404);
      }
      updateData.customerId = customerId;
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

    const shouldRecalculateAmounts =
      rate !== undefined || quantity !== undefined || quantityUnit !== undefined;
    if (shouldRecalculateAmounts) {
      const currentOrder = await tx.order.findFirst({
        where: { id, userId },
        select: { rate: true, quantity: true, quantityUnit: true },
      });
      if (!currentOrder) {
        throw new AppError("order not found", 404);
      }
      const amountData = computeOrderAmounts(
        quantity !== undefined ? Number(quantity) : Number(currentOrder.quantity),
        rate !== undefined ? Number(rate) : Number(currentOrder.rate),
        quantityUnit !== undefined ? quantityUnit : currentOrder.quantityUnit
      );
      updateData.quantityUnit = amountData.quantityUnit;
      updateData.lotMeters = amountData.lotMeters;
      updateData.meter = amountData.meter;
      updateData.commissionAmount = amountData.commissionAmount;
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
