const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");

function validateQualityPayload(body, { partial = false } = {}) {
  if (!partial && !body.name) {
    return "name is required";
  }

  return null;
}

const createQuality = asyncHandler(async (req, res) => {
  const validationError = validateQualityPayload(req.body);
  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const { name } = req.body;
  const quality = await prisma.quality.create({
    data: { name },
  });
  return res.status(201).json(quality);
});

const listQualities = asyncHandler(async (_req, res) => {
  const qualities = await prisma.quality.findMany({
    orderBy: { name: "asc" },
  });
  return res.json(qualities);
});

const getQualityById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const quality = await prisma.quality.findUnique({ where: { id } });

  if (!quality) {
    throw new AppError("quality not found", 404);
  }

  return res.json(quality);
});

const updateQuality = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const validationError = validateQualityPayload(req.body, { partial: true });

  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const { name } = req.body;
  const quality = await prisma.quality.update({
    where: { id },
    data: { name },
  });

  return res.json(quality);
});

const deleteQuality = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await prisma.quality.delete({ where: { id } });
  return res.status(204).send();
});

module.exports = {
  createQuality,
  listQualities,
  getQualityById,
  updateQuality,
  deleteQuality,
};
