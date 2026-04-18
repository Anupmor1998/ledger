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

  const name = String(req.body.name || "").trim();
  const existing = await prisma.quality.findFirst({
    where: { userId, name },
  });

  if (existing) {
    if (existing.isActive) {
      throw new AppError("quality already exists", 409);
    }

    const reactivated = await prisma.quality.update({
      where: { id: existing.id },
      data: { isActive: true },
    });
    return res.status(200).json(reactivated);
  }

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
  const includeArchived = String(req.query.includeArchived || "").toLowerCase() === "true";

  const where = {
    userId,
    ...(!includeArchived ? { isActive: true } : {}),
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
    include: {
      _count: {
        select: {
          orders: true,
        },
      },
    },
  });

  const normalizedQualities = qualities.map((quality) => ({
    ...quality,
    orderCount: quality._count?.orders || 0,
    _count: undefined,
  }));

  if (!pagination.enabled) {
    return res.json(normalizedQualities);
  }

  const total = await prisma.quality.count({ where });
  return res.json(buildPaginatedResponse(normalizedQualities, total, pagination.page, pagination.limit));
});

const getQualityById = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const quality = await prisma.quality.findFirst({
    where: { id, userId },
    include: {
      _count: {
        select: {
          orders: true,
        },
      },
    },
  });

  if (!quality) {
    throw new AppError("quality not found", 404);
  }

  return res.json({
    ...quality,
    orderCount: quality._count?.orders || 0,
    _count: undefined,
  });
});

const updateQuality = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const validationError = validateQualityPayload(req.body, { partial: true });

  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const name = req.body.name === undefined ? undefined : String(req.body.name || "").trim();
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
  const quality = await prisma.quality.findFirst({
    where: { id, userId },
    include: {
      _count: {
        select: {
          orders: true,
        },
      },
    },
  });

  if (!quality) {
    throw new AppError("quality not found", 404);
  }

  if ((quality._count?.orders || 0) > 0) {
    throw new AppError("quality is used in orders and can only be archived", 400);
  }

  const deleted = await prisma.quality.deleteMany({ where: { id, userId } });
  if (deleted.count === 0) {
    throw new AppError("quality not found", 404);
  }
  return res.status(204).send();
});

const archiveQuality = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  const quality = await prisma.quality.findFirst({
    where: { id, userId },
    include: {
      _count: {
        select: {
          orders: true,
        },
      },
    },
  });

  if (!quality) {
    throw new AppError("quality not found", 404);
  }

  if ((quality._count?.orders || 0) === 0) {
    throw new AppError("unused quality can be deleted directly", 400);
  }

  const updated = await prisma.quality.update({
    where: { id },
    data: { isActive: false },
  });

  return res.json(updated);
});

const restoreQuality = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  const quality = await prisma.quality.findFirst({ where: { id, userId }, select: { id: true } });
  if (!quality) {
    throw new AppError("quality not found", 404);
  }

  const updated = await prisma.quality.update({
    where: { id },
    data: { isActive: true },
  });

  return res.json(updated);
});

module.exports = {
  createQuality,
  listQualities,
  getQualityById,
  updateQuality,
  deleteQuality,
  archiveQuality,
  restoreQuality,
};
