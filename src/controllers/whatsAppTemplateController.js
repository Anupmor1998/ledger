const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");

/**
 * GET /api/admin/whatsapp-templates
 * List all saved WhatsApp message templates
 */
const listWhatsAppTemplates = asyncHandler(async (_req, res) => {
  const templates = await prisma.whatsAppTemplate.findMany({
    orderBy: { createdAt: "asc" },
  });

  return res.json({
    templates: Array.isArray(templates) ? templates : [],
  });
});

/**
 * POST /api/admin/whatsapp-templates
 * Create a new custom WhatsApp message template
 */
const createWhatsAppTemplate = asyncHandler(async (req, res) => {
  const { title, badge, text } = req.body;

  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) {
    throw new AppError("Template title is required", 400);
  }
  if (cleanTitle.length > 60) {
    throw new AppError("Template title must not exceed 60 characters", 400);
  }

  const cleanText = String(text || "").trim();
  if (!cleanText) {
    throw new AppError("Template text is required", 400);
  }

  const cleanBadge = String(badge || "Custom").trim().slice(0, 20);

  const template = await prisma.whatsAppTemplate.create({
    data: {
      title: cleanTitle,
      badge: cleanBadge || "Custom",
      text: cleanText,
      createdById: req.user?.userId || null,
    },
  });

  return res.status(201).json({
    message: "Template saved successfully",
    template,
  });
});

/**
 * PATCH /api/admin/whatsapp-templates/:id
 * Update an existing custom WhatsApp template
 */
const updateWhatsAppTemplate = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, badge, text } = req.body;

  const existing = await prisma.whatsAppTemplate.findUnique({
    where: { id },
  });
  if (!existing) {
    throw new AppError("Template not found", 404);
  }

  const updateData = {};
  if (title !== undefined) {
    const cleanTitle = String(title || "").trim();
    if (!cleanTitle) {
      throw new AppError("Template title cannot be empty", 400);
    }
    updateData.title = cleanTitle.slice(0, 60);
  }

  if (text !== undefined) {
    const cleanText = String(text || "").trim();
    if (!cleanText) {
      throw new AppError("Template text cannot be empty", 400);
    }
    updateData.text = cleanText;
  }

  if (badge !== undefined) {
    updateData.badge = String(badge || "Custom").trim().slice(0, 20);
  }

  const updated = await prisma.whatsAppTemplate.update({
    where: { id },
    data: updateData,
  });

  return res.json({
    message: "Template updated successfully",
    template: updated,
  });
});

/**
 * DELETE /api/admin/whatsapp-templates/:id
 * Delete a custom WhatsApp template
 */
const deleteWhatsAppTemplate = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const existing = await prisma.whatsAppTemplate.findUnique({
    where: { id },
  });
  if (!existing) {
    throw new AppError("Template not found", 404);
  }

  await prisma.whatsAppTemplate.delete({
    where: { id },
  });

  return res.json({
    message: "Template deleted successfully",
    id,
  });
});

module.exports = {
  listWhatsAppTemplates,
  createWhatsAppTemplate,
  updateWhatsAppTemplate,
  deleteWhatsAppTemplate,
};
