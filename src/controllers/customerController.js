const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const {
  buildPaginatedResponse,
  normalizeSearch,
  parsePagination,
  parseSort,
} = require("../utils/listQuery");

function validateCustomerPayload(body, { partial = false } = {}) {
  const requiredFields = ["firmName", "name", "address", "phone"];

  if (!partial) {
    for (const field of requiredFields) {
      if (!body[field]) {
        return `${field} is required`;
      }
    }
  }

  return null;
}

const COMMISSION_BASE = {
  PERCENT: "PERCENT",
  LOT: "LOT",
};

function buildCommissionData(body) {
  const commissionBase = String(body.commissionBase || COMMISSION_BASE.PERCENT)
    .trim()
    .toUpperCase();

  if (!Object.values(COMMISSION_BASE).includes(commissionBase)) {
    throw new AppError("commissionBase must be one of: PERCENT, LOT", 400);
  }

  if (commissionBase === COMMISSION_BASE.PERCENT) {
    const commissionPercent =
      body.commissionPercent === undefined || body.commissionPercent === null || body.commissionPercent === ""
        ? 1
        : Number(body.commissionPercent);

    if (!Number.isFinite(commissionPercent) || commissionPercent <= 0) {
      throw new AppError("commissionPercent must be greater than 0", 400);
    }

    return {
      commissionBase,
      commissionPercent,
      commissionLotRate: null,
    };
  }

  const commissionLotRate = Number(body.commissionLotRate);
  if (!Number.isFinite(commissionLotRate) || commissionLotRate <= 0) {
    throw new AppError("commissionLotRate must be greater than 0 when commissionBase is LOT", 400);
  }

  return {
    commissionBase,
    commissionPercent: 1,
    commissionLotRate,
  };
}

const createCustomer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const validationError = validateCustomerPayload(req.body);
  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const commissionData = buildCommissionData(req.body);
  const { firmName, name, gstNo, address, email, phone } = req.body;
  const customer = await prisma.customer.create({
    data: { userId, firmName, name, gstNo, address, email, phone, ...commissionData },
  });
  return res.status(201).json(customer);
});

const CUSTOMER_SORT_FIELDS = [
  "firmName",
  "name",
  "gstNo",
  "email",
  "phone",
  "address",
  "commissionBase",
  "commissionPercent",
  "commissionLotRate",
  "createdAt",
  "updatedAt",
];

const listCustomers = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const pagination = parsePagination(req.query);
  const { sortBy, sortOrder } = parseSort(req.query, CUSTOMER_SORT_FIELDS, "createdAt", "desc");
  const search = normalizeSearch(req.query.search);

  const where = {
    userId,
    ...(search
      ? {
        OR: [
          { firmName: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
          { gstNo: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          { phone: { contains: search, mode: "insensitive" } },
          { address: { contains: search, mode: "insensitive" } },
          { commissionBase: { equals: search.toUpperCase() } },
        ],
      }
      : {}),
  };

  const findOptions = {
    where,
    orderBy: { [sortBy]: sortOrder },
    skip: pagination.skip,
    take: pagination.take,
  };

  const customers = await prisma.customer.findMany(findOptions);

  if (!pagination.enabled) {
    return res.json(customers);
  }

  const total = await prisma.customer.count({ where });
  return res.json(buildPaginatedResponse(customers, total, pagination.page, pagination.limit));
});

const getCustomerById = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const customer = await prisma.customer.findFirst({ where: { id, userId } });

  if (!customer) {
    throw new AppError("customer not found", 404);
  }

  return res.json(customer);
});

const updateCustomer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const validationError = validateCustomerPayload(req.body, { partial: true });

  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const { firmName, name, gstNo, address, email, phone } = req.body;
  const existing = await prisma.customer.findFirst({
    where: { id, userId },
    select: {
      id: true,
      commissionBase: true,
      commissionPercent: true,
      commissionLotRate: true,
    },
  });
  if (!existing) {
    throw new AppError("customer not found", 404);
  }

  const commissionData = buildCommissionData({
    commissionBase: existing.commissionBase,
    commissionPercent: existing.commissionPercent,
    commissionLotRate: existing.commissionLotRate,
    ...req.body,
  });

  const customer = await prisma.customer.update({
    where: { id },
    data: { firmName, name, gstNo, address, email, phone, ...commissionData },
  });

  return res.json(customer);
});

const deleteCustomer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const deleted = await prisma.customer.deleteMany({ where: { id, userId } });
  if (deleted.count === 0) {
    throw new AppError("customer not found", 404);
  }
  return res.status(204).send();
});

module.exports = {
  createCustomer,
  listCustomers,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
};
