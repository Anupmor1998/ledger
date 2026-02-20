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
  const requiredFields = ["name", "address", "phone"];

  if (!partial) {
    for (const field of requiredFields) {
      if (!body[field]) {
        return `${field} is required`;
      }
    }
  }

  return null;
}

const createCustomer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const validationError = validateCustomerPayload(req.body);
  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const { name, gstNo, address, email, phone } = req.body;
  const customer = await prisma.customer.create({
    data: { userId, name, gstNo, address, email, phone },
  });
  return res.status(201).json(customer);
});

const CUSTOMER_SORT_FIELDS = ["name", "gstNo", "email", "phone", "address", "createdAt", "updatedAt"];

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
          { name: { contains: search, mode: "insensitive" } },
          { gstNo: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          { phone: { contains: search, mode: "insensitive" } },
          { address: { contains: search, mode: "insensitive" } },
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

  const { name, gstNo, address, email, phone } = req.body;
  const existing = await prisma.customer.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) {
    throw new AppError("customer not found", 404);
  }
  const customer = await prisma.customer.update({
    where: { id },
    data: { name, gstNo, address, email, phone },
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
