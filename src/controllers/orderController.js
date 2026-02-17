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
    whatsappLinks: buildOrderWhatsAppLinks(order),
  };
}

async function resolveQualityId(tx, qualityName) {
  const normalized = qualityName?.trim();
  if (!normalized) {
    throw new AppError("qualityName is required", 400);
  }

  const existing = await tx.quality.findUnique({
    where: { name: normalized },
    select: { id: true },
  });

  if (existing) {
    return existing.id;
  }

  const created = await tx.quality.create({
    data: { name: normalized },
    select: { id: true },
  });

  return created.id;
}

const createOrder = asyncHandler(async (req, res) => {
  const { customerId, manufacturerId, rate, quantity, qualityName, orderDate } = req.body;
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

  const order = await prisma.$transaction(async (tx) => {
    const qualityId = await resolveQualityId(tx, qualityName);

    return tx.order.create({
      data: {
        userId,
        customerId,
        manufacturerId,
        qualityId,
        rate,
        quantity: Number(quantity),
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
  const pagination = parsePagination(req.query);
  const { sortBy, sortOrder } = parseSort(req.query, ORDER_SORT_FIELDS, "createdAt", "desc");
  const search = normalizeSearch(req.query.search);

  const where = search
    ? {
        OR: [
          { orderNo: { contains: search, mode: "insensitive" } },
          { customer: { is: { name: { contains: search, mode: "insensitive" } } } },
          { customer: { is: { gstNo: { contains: search, mode: "insensitive" } } } },
          { manufacturer: { is: { name: { contains: search, mode: "insensitive" } } } },
          { manufacturer: { is: { gstNo: { contains: search, mode: "insensitive" } } } },
          { quality: { is: { name: { contains: search, mode: "insensitive" } } } },
        ],
      }
    : undefined;

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
  const { id } = req.params;

  const order = await prisma.order.findUnique({
    where: { id },
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
  const { id } = req.params;
  const { customerId, manufacturerId, rate, quantity, qualityName, orderDate } = req.body;

  if (
    customerId === undefined &&
    manufacturerId === undefined &&
    rate === undefined &&
    quantity === undefined &&
    qualityName === undefined &&
    orderDate === undefined
  ) {
    throw new AppError("at least one field is required to update order", 400);
  }

  if (quantity !== undefined && Number(quantity) <= 0) {
    throw new AppError("quantity must be greater than 0", 400);
  }

  if (rate !== undefined && Number(rate) <= 0) {
    throw new AppError("rate must be greater than 0", 400);
  }

  const order = await prisma.$transaction(async (tx) => {
    const updateData = {};

    if (customerId !== undefined) {
      updateData.customerId = customerId;
    }
    if (manufacturerId !== undefined) {
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
      updateData.qualityId = await resolveQualityId(tx, qualityName);
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
  const { id } = req.params;
  await prisma.order.delete({ where: { id } });
  return res.status(204).send();
});

module.exports = {
  createOrder,
  listOrders,
  getOrderById,
  updateOrder,
  deleteOrder,
};
