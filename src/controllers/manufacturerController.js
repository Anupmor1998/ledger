const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");

function validateManufacturerPayload(body, { partial = false } = {}) {
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

const createManufacturer = asyncHandler(async (req, res) => {
  const validationError = validateManufacturerPayload(req.body);
  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const { name, gstNo, address, email, phone } = req.body;
  const manufacturer = await prisma.manufacturer.create({
    data: { name, gstNo, address, email, phone },
  });
  return res.status(201).json(manufacturer);
});

const listManufacturers = asyncHandler(async (_req, res) => {
  const manufacturers = await prisma.manufacturer.findMany({
    orderBy: { createdAt: "desc" },
  });
  return res.json(manufacturers);
});

const getManufacturerById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const manufacturer = await prisma.manufacturer.findUnique({ where: { id } });

  if (!manufacturer) {
    throw new AppError("manufacturer not found", 404);
  }

  return res.json(manufacturer);
});

const updateManufacturer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const validationError = validateManufacturerPayload(req.body, { partial: true });

  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const { name, gstNo, address, email, phone } = req.body;
  const manufacturer = await prisma.manufacturer.update({
    where: { id },
    data: { name, gstNo, address, email, phone },
  });

  return res.json(manufacturer);
});

const deleteManufacturer = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.manufacturer.delete({ where: { id } });
  return res.status(204).send();
});

module.exports = {
  createManufacturer,
  listManufacturers,
  getManufacturerById,
  updateManufacturer,
  deleteManufacturer,
};
