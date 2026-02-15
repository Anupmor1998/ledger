const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");

function validateCustomerPayload(body, { partial = false } = {}) {
  const requiredFields = ["name", "gstNo", "address", "phone"];

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
  const validationError = validateCustomerPayload(req.body);
  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const { name, gstNo, address, email, phone } = req.body;
  const customer = await prisma.customer.create({
    data: { name, gstNo, address, email, phone },
  });
  return res.status(201).json(customer);
});

const listCustomers = asyncHandler(async (_req, res) => {
  const customers = await prisma.customer.findMany({
    orderBy: { createdAt: "desc" },
  });
  return res.json(customers);
});

const getCustomerById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const customer = await prisma.customer.findUnique({ where: { id } });

  if (!customer) {
    throw new AppError("customer not found", 404);
  }

  return res.json(customer);
});

const updateCustomer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const validationError = validateCustomerPayload(req.body, { partial: true });

  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const { name, gstNo, address, email, phone } = req.body;
  const customer = await prisma.customer.update({
    where: { id },
    data: { name, gstNo, address, email, phone },
  });

  return res.json(customer);
});

const deleteCustomer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.customer.delete({ where: { id } });
  return res.status(204).send();
});

module.exports = {
  createCustomer,
  listCustomers,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
};
