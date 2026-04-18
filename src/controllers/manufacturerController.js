const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const {
  buildPaginatedResponse,
  normalizeSearch,
  tokenizeSearch,
  parsePagination,
  parseSort,
} = require("../utils/listQuery");
const {
  buildDuplicateGroups,
  buildDuplicateStats,
  normalizeEmail,
  normalizePhone,
  normalizeText,
} = require("../utils/partyDuplicates");

function validateManufacturerPayload(body, { partial = false } = {}) {
  const requiredFields = ["name", "phone"];

  if (!partial) {
    for (const field of requiredFields) {
      if (!body[field]) {
        return `${field} is required`;
      }
    }
  }

  return null;
}

function isSameManufacturerCandidate(left, right) {
  const leftPhone = normalizePhone(left.phone);
  const rightPhone = normalizePhone(right.phone);
  if (leftPhone && rightPhone && leftPhone === rightPhone) {
    return true;
  }

  const leftEmail = normalizeEmail(left.email);
  const rightEmail = normalizeEmail(right.email);
  if (leftEmail && rightEmail && leftEmail === rightEmail) {
    return true;
  }

  const leftFirmName = normalizeText(left.firmName);
  const rightFirmName = normalizeText(right.firmName);
  const leftName = normalizeText(left.name);
  const rightName = normalizeText(right.name);

  if (leftName && rightName && leftName === rightName && leftFirmName && rightFirmName && leftFirmName === rightFirmName) {
    return true;
  }

  return Boolean(leftName && rightName && !leftFirmName && !rightFirmName && leftName === rightName);
}

function mergeManufacturerFields(base, incoming) {
  return {
    firmName: base.firmName || incoming.firmName || null,
    name: base.name || incoming.name || null,
    address: base.address || incoming.address || null,
    email: base.email || incoming.email || null,
    phone: base.phone || incoming.phone || null,
  };
}

async function mergeManufacturersIntoTarget(tx, userId, targetManufacturer, sourceManufacturers) {
  if (!sourceManufacturers.length) {
    return {
      mergedInto: targetManufacturer,
      ordersReassigned: 0,
      mergedCount: 0,
    };
  }

  const sourceIds = sourceManufacturers.map((entry) => entry.id);
  const updatedOrders = await tx.order.updateMany({
    where: { userId, manufacturerId: { in: sourceIds } },
    data: { manufacturerId: targetManufacturer.id },
  });

  await tx.manufacturer.deleteMany({
    where: { id: { in: sourceIds }, userId },
  });

  return {
    mergedInto: targetManufacturer,
    ordersReassigned: updatedOrders.count,
    mergedCount: sourceIds.length,
  };
}

const createManufacturer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const validationError = validateManufacturerPayload(req.body);
  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const { firmName, name, address, email, phone } = req.body;
  const manufacturer = await prisma.manufacturer.create({
    data: { userId, firmName, name, address, email, phone },
  });
  return res.status(201).json(manufacturer);
});

const MANUFACTURER_SORT_FIELDS = [
  "firmName",
  "name",
  "email",
  "phone",
  "address",
  "createdAt",
  "updatedAt",
];

const listManufacturers = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const pagination = parsePagination(req.query);
  const { sortBy, sortOrder } = parseSort(
    req.query,
    MANUFACTURER_SORT_FIELDS,
    "createdAt",
    "desc"
  );
  const search = normalizeSearch(req.query.search);
  const searchTokens = tokenizeSearch(search);
  const duplicatesOnly = String(req.query.duplicatesOnly || "").toLowerCase() === "true";

  const duplicateSourceRows = await prisma.manufacturer.findMany({
    where: { userId },
    select: {
      id: true,
      firmName: true,
      name: true,
      phone: true,
    },
  });

  const duplicateStats = buildDuplicateStats(duplicateSourceRows);

  const where = {
    userId,
    ...(duplicatesOnly
      ? {
          id: {
            in: duplicateStats.duplicateIds.length > 0 ? duplicateStats.duplicateIds : ["__no_duplicate_manufacturer__"],
          },
        }
      : {}),
    ...(searchTokens.length
      ? {
        AND: searchTokens.map((token) => ({
          OR: [
            { firmName: { contains: token, mode: "insensitive" } },
            { name: { contains: token, mode: "insensitive" } },
            { email: { contains: token, mode: "insensitive" } },
            { phone: { contains: token, mode: "insensitive" } },
            { address: { contains: token, mode: "insensitive" } },
          ],
        })),
      }
      : {}),
  };

  const manufacturers = await prisma.manufacturer.findMany({
    where,
    orderBy: { [sortBy]: sortOrder },
    skip: pagination.skip,
    take: pagination.take,
  });
  const enrichedManufacturers = manufacturers.map((manufacturer) => ({
    ...manufacturer,
    duplicateCount: duplicateStats.duplicateCounts[manufacturer.id] || 0,
    hasDuplicate: Boolean(duplicateStats.duplicateCounts[manufacturer.id]),
  }));

  if (!pagination.enabled) {
    return res.json(enrichedManufacturers);
  }

  const total = await prisma.manufacturer.count({ where });
  return res.json(
    buildPaginatedResponse(enrichedManufacturers, total, pagination.page, pagination.limit)
  );
});

const getManufacturerById = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const manufacturer = await prisma.manufacturer.findFirst({ where: { id, userId } });

  if (!manufacturer) {
    throw new AppError("manufacturer not found", 404);
  }

  return res.json(manufacturer);
});

const updateManufacturer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const validationError = validateManufacturerPayload(req.body, { partial: true });

  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const { firmName, name, address, email, phone } = req.body;
  const existing = await prisma.manufacturer.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!existing) {
    throw new AppError("manufacturer not found", 404);
  }
  const manufacturer = await prisma.manufacturer.update({
    where: { id },
    data: { firmName, name, address, email, phone },
  });

  return res.json(manufacturer);
});

const deleteManufacturer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const deleted = await prisma.manufacturer.deleteMany({ where: { id, userId } });
  if (deleted.count === 0) {
    throw new AppError("manufacturer not found", 404);
  }
  return res.status(204).send();
});

const listManufacturerDuplicateGroups = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const rows = await prisma.manufacturer.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  const groups = buildDuplicateGroups(
    rows.map((row) => ({
      id: row.id,
      firmName: row.firmName,
      name: row.name,
      phone: row.phone,
    }))
  );

  const itemsById = new Map(rows.map((row) => [row.id, row]));
  const duplicateGroups = groups.map((groupIds, index) => ({
    id: `manufacturer-group-${index + 1}`,
    records: groupIds.map((id) => itemsById.get(id)).filter(Boolean),
  }));

  return res.json({
    totalGroups: duplicateGroups.length,
    groups: duplicateGroups,
  });
});

const checkManufacturerDuplicates = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const validationError = validateManufacturerPayload(req.body);
  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const candidate = {
    firmName: req.body.firmName,
    name: req.body.name,
    address: req.body.address,
    email: req.body.email,
    phone: req.body.phone,
  };

  const rows = await prisma.manufacturer.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  const candidates = rows.filter((row) => isSameManufacturerCandidate(candidate, row));

  return res.json({
    hasDuplicates: candidates.length > 0,
    candidates,
  });
});

const previewMergeManufacturer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const sourceId = req.params.id;
  const targetId = String(req.query?.targetId || "").trim();

  if (!targetId) {
    throw new AppError("targetId is required", 400);
  }

  if (sourceId === targetId) {
    throw new AppError("source and target manufacturer cannot be the same", 400);
  }

  const [source, target, ordersReassigned] = await Promise.all([
    prisma.manufacturer.findFirst({
      where: { id: sourceId, userId },
      select: { id: true, firmName: true, name: true },
    }),
    prisma.manufacturer.findFirst({
      where: { id: targetId, userId },
      select: { id: true, firmName: true, name: true },
    }),
    prisma.order.count({
      where: { userId, manufacturerId: sourceId },
    }),
  ]);

  if (!source) {
    throw new AppError("manufacturer to merge was not found", 404);
  }

  if (!target) {
    throw new AppError("target manufacturer was not found", 404);
  }

  return res.json({
    source,
    target,
    ordersReassigned,
  });
});

const mergeManufacturer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const sourceId = req.params.id;
  const targetId = String(req.body?.targetId || "").trim();

  if (!targetId) {
    throw new AppError("targetId is required", 400);
  }

  if (sourceId === targetId) {
    throw new AppError("source and target manufacturer cannot be the same", 400);
  }

  const result = await prisma.$transaction(async (tx) => {
    const [source, target] = await Promise.all([
      tx.manufacturer.findFirst({ where: { id: sourceId, userId } }),
      tx.manufacturer.findFirst({ where: { id: targetId, userId } }),
    ]);

    if (!source) {
      throw new AppError("manufacturer to merge was not found", 404);
    }

    if (!target) {
      throw new AppError("target manufacturer was not found", 404);
    }

    const mergedTarget = await tx.manufacturer.update({
      where: { id: target.id },
      data: {
        firmName: target.firmName || source.firmName,
        name: target.name || source.name,
        address: target.address || source.address,
        email: target.email || source.email,
        phone: target.phone || source.phone,
      },
    });

    const updatedOrders = await tx.order.updateMany({
      where: { userId, manufacturerId: source.id },
      data: { manufacturerId: target.id },
    });

    await tx.manufacturer.delete({
      where: { id: source.id },
    });

    return {
      mergedInto: mergedTarget,
      ordersReassigned: updatedOrders.count,
    };
  });

  return res.json({
    message: "manufacturer merged successfully",
    ...result,
  });
});

const resolveManufacturerDuplicates = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const draft = req.body?.draft || {};
  const validationError = validateManufacturerPayload(draft);
  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const keepId = String(req.body?.keepId || "").trim();
  const mergeIds = Array.isArray(req.body?.mergeIds)
    ? [...new Set(req.body.mergeIds.map((value) => String(value || "").trim()).filter(Boolean))]
    : [];

  if (!keepId) {
    throw new AppError("keepId is required", 400);
  }

  if (mergeIds.length === 0) {
    throw new AppError("select at least one record to merge", 400);
  }

  const keepDraft = keepId === "draft";
  const mergeDraft = mergeIds.includes("draft");
  const dbMergeIds = mergeIds.filter((id) => id !== "draft");
  if (!keepDraft && mergeIds.includes(keepId)) {
    throw new AppError("record to keep cannot also be merged", 400);
  }

  const result = await prisma.$transaction(async (tx) => {
    const sourceManufacturers = await tx.manufacturer.findMany({
      where: { id: { in: dbMergeIds }, userId },
    });

    if (sourceManufacturers.length !== dbMergeIds.length) {
      throw new AppError("one or more selected duplicate records were not found", 404);
    }

    let targetManufacturer;

    if (keepDraft) {
      const mergedDraft = sourceManufacturers.reduce(
        (acc, row) => mergeManufacturerFields(acc, row),
        {
          firmName: draft.firmName || null,
          name: draft.name,
          address: draft.address || null,
          email: draft.email || null,
          phone: draft.phone,
        }
      );

      targetManufacturer = await tx.manufacturer.create({
        data: {
          userId,
          ...mergedDraft,
        },
      });
    } else {
      targetManufacturer = await tx.manufacturer.findFirst({
        where: { id: keepId, userId },
      });

      if (!targetManufacturer) {
        throw new AppError("record to keep was not found", 404);
      }

      const mergedData = sourceManufacturers.reduce(
        (acc, row) => mergeManufacturerFields(acc, row),
        mergeDraft
          ? {
              firmName: targetManufacturer.firmName || draft.firmName || null,
              name: targetManufacturer.name || draft.name,
              address: targetManufacturer.address || draft.address || null,
              email: targetManufacturer.email || draft.email || null,
              phone: targetManufacturer.phone || draft.phone,
            }
          : {
              firmName: targetManufacturer.firmName,
              name: targetManufacturer.name,
              address: targetManufacturer.address,
              email: targetManufacturer.email,
              phone: targetManufacturer.phone,
            }
      );

      targetManufacturer = await tx.manufacturer.update({
        where: { id: keepId },
        data: mergedData,
      });
    }

    return mergeManufacturersIntoTarget(tx, userId, targetManufacturer, sourceManufacturers);
  });

  return res.json({
    message: "manufacturer duplicates merged successfully",
    ...result,
  });
});

module.exports = {
  createManufacturer,
  checkManufacturerDuplicates,
  listManufacturerDuplicateGroups,
  listManufacturers,
  getManufacturerById,
  updateManufacturer,
  deleteManufacturer,
  previewMergeManufacturer,
  mergeManufacturer,
  resolveManufacturerDuplicates,
};
