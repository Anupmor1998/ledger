const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const {
  buildPaginatedResponse,
  normalizeSearch,
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

function validateCustomerPayload(body, { partial = false } = {}) {
  const requiredFields = ["firmName", "name", "address", "phone"];

  if (!partial) {
    for (const field of requiredFields) {
      if (!body[field]) {
        return `${field} is required`;
      }
    }
  }

  return null;
}

function getCustomerDisplayName(customer) {
  return String(customer?.firmName || customer?.name || "").trim();
}

function isSameCustomerCandidate(left, right) {
  const leftPhone = normalizePhone(left.phone);
  const rightPhone = normalizePhone(right.phone);
  if (leftPhone && rightPhone && leftPhone === rightPhone) {
    return true;
  }

  const leftGst = normalizeText(left.gstNo);
  const rightGst = normalizeText(right.gstNo);
  if (leftGst && rightGst && leftGst === rightGst) {
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

  return Boolean(leftName && rightName && leftFirmName && rightFirmName && leftName === rightName && leftFirmName === rightFirmName);
}

function mergeCustomerFields(base, incoming) {
  return {
    firmName: base.firmName || incoming.firmName || null,
    name: base.name || incoming.name || null,
    gstNo: base.gstNo || incoming.gstNo || null,
    address: base.address || incoming.address || null,
    email: base.email || incoming.email || null,
    phone: base.phone || incoming.phone || null,
    commissionBase: base.commissionBase || incoming.commissionBase || COMMISSION_BASE.PERCENT,
    commissionPercent:
      base.commissionPercent !== undefined && base.commissionPercent !== null
        ? base.commissionPercent
        : incoming.commissionPercent ?? 1,
    commissionLotRate:
      base.commissionLotRate !== undefined && base.commissionLotRate !== null
        ? base.commissionLotRate
        : incoming.commissionLotRate ?? null,
  };
}

async function syncCustomerPendingPaymentNames(tx, userId, customerId, accountName) {
  const pendingPayments = await tx.pendingPayment.findMany({
    where: {
      userId,
      order: { customerId },
    },
    select: { id: true },
  });

  const pendingPaymentIds = pendingPayments.map((entry) => entry.id);
  if (pendingPaymentIds.length === 0) {
    return 0;
  }

  await tx.pendingPayment.updateMany({
    where: { id: { in: pendingPaymentIds } },
    data: { accountName },
  });

  await tx.paymentReceipt.updateMany({
    where: {
      paymentAllocations: {
        some: { pendingPaymentId: { in: pendingPaymentIds } },
      },
    },
    data: { accountName },
  });

  return pendingPaymentIds.length;
}

async function mergeCustomersIntoTarget(tx, userId, targetCustomer, sourceCustomers) {
  if (!sourceCustomers.length) {
    return {
      mergedInto: targetCustomer,
      ordersReassigned: 0,
      pendingPaymentsUpdated: 0,
      mergedCount: 0,
    };
  }

  const sourceIds = sourceCustomers.map((entry) => entry.id);
  const updatedOrders = await tx.order.updateMany({
    where: { userId, customerId: { in: sourceIds } },
    data: { customerId: targetCustomer.id },
  });

  await tx.customer.deleteMany({
    where: { id: { in: sourceIds }, userId },
  });

  const pendingPaymentsUpdated = await syncCustomerPendingPaymentNames(
    tx,
    userId,
    targetCustomer.id,
    getCustomerDisplayName(targetCustomer)
  );

  return {
    mergedInto: targetCustomer,
    ordersReassigned: updatedOrders.count,
    pendingPaymentsUpdated,
    mergedCount: sourceIds.length,
  };
}

const COMMISSION_BASE = {
  PERCENT: "PERCENT",
  LOT: "LOT",
};

function buildCommissionData(body) {
  const commissionBase = String(body.commissionBase || COMMISSION_BASE.PERCENT)
    .trim()
    .toUpperCase();

  if (!Object.values(COMMISSION_BASE).includes(commissionBase)) {
    throw new AppError("commissionBase must be one of: PERCENT, LOT", 400);
  }

  if (commissionBase === COMMISSION_BASE.PERCENT) {
    const commissionPercent =
      body.commissionPercent === undefined || body.commissionPercent === null || body.commissionPercent === ""
        ? 1
        : Number(body.commissionPercent);

    if (!Number.isFinite(commissionPercent) || commissionPercent <= 0) {
      throw new AppError("commissionPercent must be greater than 0", 400);
    }

    return {
      commissionBase,
      commissionPercent,
      commissionLotRate: null,
    };
  }

  const commissionLotRate = Number(body.commissionLotRate);
  if (!Number.isFinite(commissionLotRate) || commissionLotRate <= 0) {
    throw new AppError("commissionLotRate must be greater than 0 when commissionBase is LOT", 400);
  }

  return {
    commissionBase,
    commissionPercent: 1,
    commissionLotRate,
  };
}

const createCustomer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const validationError = validateCustomerPayload(req.body);
  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const commissionData = buildCommissionData(req.body);
  const { firmName, name, gstNo, address, email, phone } = req.body;
  const customer = await prisma.customer.create({
    data: { userId, firmName, name, gstNo, address, email, phone, ...commissionData },
  });
  return res.status(201).json(customer);
});

const CUSTOMER_SORT_FIELDS = [
  "firmName",
  "name",
  "gstNo",
  "email",
  "phone",
  "address",
  "commissionBase",
  "commissionPercent",
  "commissionLotRate",
  "createdAt",
  "updatedAt",
];

const listCustomers = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const pagination = parsePagination(req.query);
  const { sortBy, sortOrder } = parseSort(req.query, CUSTOMER_SORT_FIELDS, "createdAt", "desc");
  const search = normalizeSearch(req.query.search);
  const duplicatesOnly = String(req.query.duplicatesOnly || "").toLowerCase() === "true";

  const duplicateSourceRows = await prisma.customer.findMany({
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
            in: duplicateStats.duplicateIds.length > 0 ? duplicateStats.duplicateIds : ["__no_duplicate_customer__"],
          },
        }
      : {}),
    ...(search
      ? {
        OR: [
          { firmName: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
          { gstNo: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          { phone: { contains: search, mode: "insensitive" } },
          { address: { contains: search, mode: "insensitive" } },
          { commissionBase: { equals: search.toUpperCase() } },
        ],
      }
      : {}),
  };

  const findOptions = {
    where,
    orderBy: { [sortBy]: sortOrder },
    skip: pagination.skip,
    take: pagination.take,
  };

  const customers = await prisma.customer.findMany(findOptions);
  const enrichedCustomers = customers.map((customer) => ({
    ...customer,
    duplicateCount: duplicateStats.duplicateCounts[customer.id] || 0,
    hasDuplicate: Boolean(duplicateStats.duplicateCounts[customer.id]),
  }));

  if (!pagination.enabled) {
    return res.json(enrichedCustomers);
  }

  const total = await prisma.customer.count({ where });
  return res.json(buildPaginatedResponse(enrichedCustomers, total, pagination.page, pagination.limit));
});

const getCustomerById = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const customer = await prisma.customer.findFirst({ where: { id, userId } });

  if (!customer) {
    throw new AppError("customer not found", 404);
  }

  return res.json(customer);
});

const updateCustomer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const validationError = validateCustomerPayload(req.body, { partial: true });

  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const { firmName, name, gstNo, address, email, phone } = req.body;
  const existing = await prisma.customer.findFirst({
    where: { id, userId },
    select: {
      id: true,
      commissionBase: true,
      commissionPercent: true,
      commissionLotRate: true,
    },
  });
  if (!existing) {
    throw new AppError("customer not found", 404);
  }

  const commissionData = buildCommissionData({
    commissionBase: existing.commissionBase,
    commissionPercent: existing.commissionPercent,
    commissionLotRate: existing.commissionLotRate,
    ...req.body,
  });

  const customer = await prisma.customer.update({
    where: { id },
    data: { firmName, name, gstNo, address, email, phone, ...commissionData },
  });

  return res.json(customer);
});

const deleteCustomer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const deleted = await prisma.customer.deleteMany({ where: { id, userId } });
  if (deleted.count === 0) {
    throw new AppError("customer not found", 404);
  }
  return res.status(204).send();
});

const listCustomerDuplicateGroups = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const rows = await prisma.customer.findMany({
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
    id: `customer-group-${index + 1}`,
    records: groupIds.map((id) => itemsById.get(id)).filter(Boolean),
  }));

  return res.json({
    totalGroups: duplicateGroups.length,
    groups: duplicateGroups,
  });
});

const checkCustomerDuplicates = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const validationError = validateCustomerPayload(req.body);
  if (validationError) {
    throw new AppError(validationError, 400);
  }

  const candidate = {
    firmName: req.body.firmName,
    name: req.body.name,
    gstNo: req.body.gstNo,
    address: req.body.address,
    email: req.body.email,
    phone: req.body.phone,
    commissionBase: req.body.commissionBase,
    commissionPercent: req.body.commissionPercent,
    commissionLotRate: req.body.commissionLotRate,
  };

  const rows = await prisma.customer.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  const candidates = rows.filter((row) => isSameCustomerCandidate(candidate, row));

  return res.json({
    hasDuplicates: candidates.length > 0,
    candidates,
  });
});

const previewMergeCustomer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const sourceId = req.params.id;
  const targetId = String(req.query?.targetId || "").trim();

  if (!targetId) {
    throw new AppError("targetId is required", 400);
  }

  if (sourceId === targetId) {
    throw new AppError("source and target customer cannot be the same", 400);
  }

  const [source, target, ordersReassigned, pendingPaymentsUpdated, receivedPaymentsUpdated] =
    await Promise.all([
      prisma.customer.findFirst({
        where: { id: sourceId, userId },
        select: { id: true, firmName: true, name: true },
      }),
      prisma.customer.findFirst({
        where: { id: targetId, userId },
        select: { id: true, firmName: true, name: true },
      }),
      prisma.order.count({
        where: { userId, customerId: sourceId },
      }),
      prisma.pendingPayment.count({
        where: {
          userId,
          order: { customerId: sourceId },
        },
      }),
      prisma.paymentReceipt.count({
        where: {
          paymentAllocations: {
            some: {
              pendingPayment: {
                userId,
                order: { customerId: sourceId },
              },
            },
          },
        },
      }),
    ]);

  if (!source) {
    throw new AppError("customer to merge was not found", 404);
  }

  if (!target) {
    throw new AppError("target customer was not found", 404);
  }

  return res.json({
    source,
    target,
    ordersReassigned,
    pendingPaymentsUpdated,
    receivedPaymentsUpdated,
  });
});

const mergeCustomer = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const sourceId = req.params.id;
  const targetId = String(req.body?.targetId || "").trim();

  if (!targetId) {
    throw new AppError("targetId is required", 400);
  }

  if (sourceId === targetId) {
    throw new AppError("source and target customer cannot be the same", 400);
  }

  const result = await prisma.$transaction(async (tx) => {
    const [source, target] = await Promise.all([
      tx.customer.findFirst({ where: { id: sourceId, userId } }),
      tx.customer.findFirst({ where: { id: targetId, userId } }),
    ]);

    if (!source) {
      throw new AppError("customer to merge was not found", 404);
    }

    if (!target) {
      throw new AppError("target customer was not found", 404);
    }

    const mergedTarget = await tx.customer.update({
      where: { id: target.id },
      data: {
        firmName: target.firmName || source.firmName,
        name: target.name || source.name,
        gstNo: target.gstNo || source.gstNo,
        address: target.address || source.address,
        email: target.email || source.email,
        phone: target.phone || source.phone,
      },
    });

    const pendingPayments = await tx.pendingPayment.findMany({
      where: {
        userId,
        order: { customerId: source.id },
      },
      select: { id: true },
    });

    const pendingPaymentIds = pendingPayments.map((entry) => entry.id);
    const mergedAccountName = getCustomerDisplayName(mergedTarget);

    const updatedOrders = await tx.order.updateMany({
      where: { userId, customerId: source.id },
      data: { customerId: target.id },
    });

    if (pendingPaymentIds.length > 0) {
      await tx.pendingPayment.updateMany({
        where: { id: { in: pendingPaymentIds } },
        data: { accountName: mergedAccountName },
      });

      await tx.paymentReceipt.updateMany({
        where: {
          paymentAllocations: {
            some: { pendingPaymentId: { in: pendingPaymentIds } },
          },
        },
        data: { accountName: mergedAccountName },
      });
    }

    await tx.customer.delete({
      where: { id: source.id },
    });

    return {
      mergedInto: mergedTarget,
      ordersReassigned: updatedOrders.count,
      pendingPaymentsUpdated: pendingPaymentIds.length,
    };
  });

  return res.json({
    message: "customer merged successfully",
    ...result,
  });
});

const resolveCustomerDuplicates = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const draft = req.body?.draft || {};
  const validationError = validateCustomerPayload(draft);
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
    const commissionData = buildCommissionData(draft);
    const sourceCustomers = await tx.customer.findMany({
      where: { id: { in: dbMergeIds }, userId },
    });

    if (sourceCustomers.length !== dbMergeIds.length) {
      throw new AppError("one or more selected duplicate records were not found", 404);
    }

    let targetCustomer;

    if (keepDraft) {
      const mergedDraft = sourceCustomers.reduce(
        (acc, row) => mergeCustomerFields(acc, row),
        {
          firmName: draft.firmName,
          name: draft.name,
          gstNo: draft.gstNo || null,
          address: draft.address,
          email: draft.email || null,
          phone: draft.phone,
          ...commissionData,
        }
      );

      targetCustomer = await tx.customer.create({
        data: {
          userId,
          ...mergedDraft,
        },
      });
    } else {
      targetCustomer = await tx.customer.findFirst({
        where: { id: keepId, userId },
      });

      if (!targetCustomer) {
        throw new AppError("record to keep was not found", 404);
      }

      const mergedData = sourceCustomers.reduce(
        (acc, row) => mergeCustomerFields(acc, row),
        mergeDraft
          ? {
              firmName: targetCustomer.firmName || draft.firmName,
              name: targetCustomer.name || draft.name,
              gstNo: targetCustomer.gstNo || draft.gstNo || null,
              address: targetCustomer.address || draft.address,
              email: targetCustomer.email || draft.email || null,
              phone: targetCustomer.phone || draft.phone,
              commissionBase: targetCustomer.commissionBase || commissionData.commissionBase,
              commissionPercent:
                targetCustomer.commissionPercent ?? commissionData.commissionPercent ?? 1,
              commissionLotRate:
                targetCustomer.commissionLotRate ?? commissionData.commissionLotRate ?? null,
            }
          : {
              firmName: targetCustomer.firmName,
              name: targetCustomer.name,
              gstNo: targetCustomer.gstNo,
              address: targetCustomer.address,
              email: targetCustomer.email,
              phone: targetCustomer.phone,
              commissionBase: targetCustomer.commissionBase,
              commissionPercent: targetCustomer.commissionPercent,
              commissionLotRate: targetCustomer.commissionLotRate,
            }
      );

      targetCustomer = await tx.customer.update({
        where: { id: keepId },
        data: mergedData,
      });
    }

    return mergeCustomersIntoTarget(tx, userId, targetCustomer, sourceCustomers);
  });

  return res.json({
    message: "customer duplicates merged successfully",
    ...result,
  });
});

module.exports = {
  createCustomer,
  checkCustomerDuplicates,
  listCustomerDuplicateGroups,
  listCustomers,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
  previewMergeCustomer,
  mergeCustomer,
  resolveCustomerDuplicates,
};
