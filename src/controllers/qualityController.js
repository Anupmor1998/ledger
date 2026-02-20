const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const {
  buildPaginatedResponse,
  normalizeSearch,
  parsePagination,
  parseSort,
} = require("../utils/listQuery");

function validateQualityPayload(body, { partial = false } = {}) {
  if (!partial && !body.name) {
    return "name is required";
  }

  return null;
}

const createQuality = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const validationError = validateQualityPayload(req.body);
  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const { name } = req.body;
  const quality = await prisma.quality.create({
    data: { userId, name },
  });
  return res.status(201).json(quality);
});

const QUALITY_SORT_FIELDS = ["name", "createdAt", "updatedAt"];

const listQualities = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const pagination = parsePagination(req.query);
  const { sortBy, sortOrder } = parseSort(req.query, QUALITY_SORT_FIELDS, "name", "asc");
  const search = normalizeSearch(req.query.search);

  const where = {
    userId,
    ...(search
      ? {
        name: { contains: search, mode: "insensitive" },
      }
      : {}),
  };

  const qualities = await prisma.quality.findMany({
    where,
    orderBy: { [sortBy]: sortOrder },
    skip: pagination.skip,
    take: pagination.take,
  });

  if (!pagination.enabled) {
    return res.json(qualities);
  }

  const total = await prisma.quality.count({ where });
  return res.json(buildPaginatedResponse(qualities, total, pagination.page, pagination.limit));
});

const getQualityById = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const quality = await prisma.quality.findFirst({ where: { id, userId } });

  if (!quality) {
    throw new AppError("quality not found", 404);
  }

  return res.json(quality);
});

const updateQuality = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const validationError = validateQualityPayload(req.body, { partial: true });

  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const { name } = req.body;
  const existing = await prisma.quality.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) {
    throw new AppError("quality not found", 404);
  }
  const quality = await prisma.quality.update({
    where: { id },
    data: { name },
  });

  return res.json(quality);
});

const deleteQuality = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const deleted = await prisma.quality.deleteMany({ where: { id, userId } });
  if (deleted.count === 0) {
    throw new AppError("quality not found", 404);
  }
  return res.status(204).send();
});

module.exports = {
  createQuality,
  listQualities,
  getQualityById,
  updateQuality,
  deleteQuality,
};
