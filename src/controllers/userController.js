const bcrypt = require("bcryptjs");
const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");

const ALLOWED_THEMES = ["light", "dark"];
const SALT_ROUNDS = 10;

const listUsers = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, theme: true, createdAt: true, updatedAt: true },
  });

  if (!user) {
    throw new AppError("user not found", 404);
  }

  return res.json([user]);
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

const updateMyProfile = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { name, email, currentPassword, newPassword } = req.body;

  const hasName = name !== undefined;
  const hasEmail = email !== undefined;
  const hasCurrentPassword = currentPassword !== undefined && currentPassword !== "";
  const hasNewPassword = newPassword !== undefined && newPassword !== "";

  if (!hasName && !hasEmail && !hasCurrentPassword && !hasNewPassword) {
    throw new AppError("at least one field is required", 400);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
  });
  if (!user) {
    throw new AppError("user not found", 404);
  }

  const updateData = {};

  if (hasName) {
    updateData.name = String(name || "").trim() || null;
  }

  if (hasEmail) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail) {
      throw new AppError("email cannot be empty", 400);
    }
    updateData.email = normalizedEmail;
  }

  if (hasCurrentPassword || hasNewPassword) {
    if (!hasCurrentPassword || !hasNewPassword) {
      throw new AppError("currentPassword and newPassword are both required", 400);
    }
    if (String(newPassword).length < 8) {
      throw new AppError("newPassword must be at least 8 characters", 400);
    }
    const isCurrentPasswordValid = await bcrypt.compare(String(currentPassword), user.password);
    if (!isCurrentPasswordValid) {
      throw new AppError("current password is incorrect", 400);
    }
    updateData.password = await bcrypt.hash(String(newPassword), SALT_ROUNDS);
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: updateData,
    select: {
      id: true,
      email: true,
      name: true,
      theme: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return res.json(updated);
});

module.exports = {
  listUsers,
  getMyPreferences,
  updateMyPreferences,
  updateMyProfile,
};
