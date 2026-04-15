const bcrypt = require("bcryptjs");
const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const { getFinancialYearStartYear, getFinancialYearLabel } = require("../utils/financialYear");

const ALLOWED_THEMES = ["light", "dark"];
const SALT_ROUNDS = 10;
const WHATSAPP_GROUP_INVITE_REGEX =
  /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+(?:\?.*)?$/i;

const listUsers = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      theme: true,
      selectedFinancialYearStart: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) {
    throw new AppError("user not found", 404);
  }

  return res.json([
    {
      ...user,
      selectedFinancialYearStart:
        user.selectedFinancialYearStart ?? getFinancialYearStartYear(),
    },
  ]);
});

const getMyPreferences = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      theme: true,
      selectedFinancialYearStart: true,
    },
  });

  if (!user) {
    throw new AppError("user not found", 404);
  }

  const selectedFinancialYearStart =
    user.selectedFinancialYearStart ?? getFinancialYearStartYear();

  return res.json({
    theme: user.theme,
    selectedFinancialYearStart,
    selectedFinancialYearLabel: getFinancialYearLabel(selectedFinancialYearStart),
  });
});

const updateMyPreferences = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { theme, selectedFinancialYearStart } = req.body;
  const hasTheme = theme !== undefined;
  const hasFinancialYear = selectedFinancialYearStart !== undefined;

  if (!hasTheme && !hasFinancialYear) {
    throw new AppError("at least one preference field is required", 400);
  }

  const data = {};

  if (hasTheme) {
    if (!theme || !ALLOWED_THEMES.includes(theme)) {
      throw new AppError("theme must be one of: light, dark", 400);
    }
    data.theme = theme;
  }

  if (hasFinancialYear) {
    const nextFinancialYear = Number(selectedFinancialYearStart);
    if (!Number.isInteger(nextFinancialYear) || nextFinancialYear < 2000 || nextFinancialYear > 2100) {
      throw new AppError("selectedFinancialYearStart must be a valid financial year", 400);
    }
    data.selectedFinancialYearStart = nextFinancialYear;
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data,
    select: {
      theme: true,
      selectedFinancialYearStart: true,
    },
  });

  const effectiveFinancialYear =
    updated.selectedFinancialYearStart ?? getFinancialYearStartYear();

  return res.json({
    theme: updated.theme,
    selectedFinancialYearStart: effectiveFinancialYear,
    selectedFinancialYearLabel: getFinancialYearLabel(effectiveFinancialYear),
  });
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
      selectedFinancialYearStart: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return res.json({
    ...updated,
    selectedFinancialYearStart:
      updated.selectedFinancialYearStart ?? getFinancialYearStartYear(),
  });
});

const listMyRemarkTemplates = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const templates = await prisma.remarkTemplate.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  return res.json(templates);
});

const createMyRemarkTemplate = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const text = String(req.body?.text || "").trim();

  if (!text) {
    throw new AppError("text is required", 400);
  }

  const created = await prisma.remarkTemplate.create({
    data: { userId, text },
  });
  return res.status(201).json(created);
});

const deleteMyRemarkTemplate = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const deleted = await prisma.remarkTemplate.deleteMany({
    where: { id, userId },
  });
  if (deleted.count === 0) {
    throw new AppError("remark template not found", 404);
  }
  return res.status(204).send();
});

const listMyWhatsAppGroups = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const groups = await prisma.whatsAppGroup.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  return res.json(groups);
});

const createMyWhatsAppGroup = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const name = String(req.body?.name || "").trim();
  const inviteLink = String(req.body?.inviteLink || "").trim();

  if (!name) {
    throw new AppError("name is required", 400);
  }
  if (!inviteLink || !WHATSAPP_GROUP_INVITE_REGEX.test(inviteLink)) {
    throw new AppError("inviteLink must be a valid WhatsApp group link", 400);
  }

  const created = await prisma.whatsAppGroup.create({
    data: { userId, name, inviteLink },
  });
  return res.status(201).json(created);
});

const updateMyWhatsAppGroup = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const hasName = req.body?.name !== undefined;
  const hasInviteLink = req.body?.inviteLink !== undefined;

  if (!hasName && !hasInviteLink) {
    throw new AppError("at least one field is required", 400);
  }

  const existing = await prisma.whatsAppGroup.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!existing) {
    throw new AppError("whatsapp group not found", 404);
  }

  const data = {};
  if (hasName) {
    const name = String(req.body.name || "").trim();
    if (!name) {
      throw new AppError("name cannot be empty", 400);
    }
    data.name = name;
  }
  if (hasInviteLink) {
    const inviteLink = String(req.body.inviteLink || "").trim();
    if (!inviteLink || !WHATSAPP_GROUP_INVITE_REGEX.test(inviteLink)) {
      throw new AppError("inviteLink must be a valid WhatsApp group link", 400);
    }
    data.inviteLink = inviteLink;
  }

  const updated = await prisma.whatsAppGroup.update({
    where: { id },
    data,
  });
  return res.json(updated);
});

const deleteMyWhatsAppGroup = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const deleted = await prisma.whatsAppGroup.deleteMany({
    where: { id, userId },
  });
  if (deleted.count === 0) {
    throw new AppError("whatsapp group not found", 404);
  }
  return res.status(204).send();
});

module.exports = {
  listUsers,
  getMyPreferences,
  updateMyPreferences,
  updateMyProfile,
  listMyRemarkTemplates,
  createMyRemarkTemplate,
  deleteMyRemarkTemplate,
  listMyWhatsAppGroups,
  createMyWhatsAppGroup,
  updateMyWhatsAppGroup,
  deleteMyWhatsAppGroup,
};
