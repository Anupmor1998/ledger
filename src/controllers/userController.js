const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");

const ALLOWED_THEMES = ["light", "dark"];

const listUsers = asyncHandler(async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { id: "asc" },
    select: { id: true, email: true, name: true, theme: true, createdAt: true, updatedAt: true },
  });

  return res.json(users);
});

const getMyPreferences = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { theme: true },
  });

  if (!user) {
    throw new AppError("user not found", 404);
  }

  return res.json({ theme: user.theme });
});

const updateMyPreferences = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { theme } = req.body;

  if (!theme || !ALLOWED_THEMES.includes(theme)) {
    throw new AppError("theme must be one of: light, dark", 400);
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { theme },
    select: { theme: true },
  });

  return res.json(updated);
});

module.exports = {
  listUsers,
  getMyPreferences,
  updateMyPreferences,
};
