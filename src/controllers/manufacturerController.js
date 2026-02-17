const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const {
  buildPaginatedResponse,
  normalizeSearch,
  parsePagination,
  parseSort,
} = require("../utils/listQuery");

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

const MANUFACTURER_SORT_FIELDS = [
  "name",
  "gstNo",
  "email",
  "phone",
  "address",
  "createdAt",
  "updatedAt",
];

const listManufacturers = asyncHandler(async (req, res) => {
  const pagination = parsePagination(req.query);
  const { sortBy, sortOrder } = parseSort(
    req.query,
    MANUFACTURER_SORT_FIELDS,
    "createdAt",
    "desc"
  );
  const search = normalizeSearch(req.query.search);

  const where = search
    ? {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { gstNo: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          { phone: { contains: search, mode: "insensitive" } },
          { address: { contains: search, mode: "insensitive" } },
        ],
      }
    : undefined;

  const manufacturers = await prisma.manufacturer.findMany({
    where,
    orderBy: { [sortBy]: sortOrder },
    skip: pagination.skip,
    take: pagination.take,
  });

  if (!pagination.enabled) {
    return res.json(manufacturers);
  }

  const total = await prisma.manufacturer.count({ where });
  return res.json(buildPaginatedResponse(manufacturers, total, pagination.page, pagination.limit));
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
