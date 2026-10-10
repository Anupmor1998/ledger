const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const {
  getAdminCollectionConfig,
  getAdminCollectionKeys,
} = require("../config/adminCollections");

function getCollectionConfigOrThrow(collectionKey) {
  const config = getAdminCollectionConfig(collectionKey);
  if (!config) {
    throw new AppError("collection not found", 404);
  }
  return config;
}

function getDelegate(collectionKey) {
  const config = getCollectionConfigOrThrow(collectionKey);
  const delegate = prisma[config.delegate];

  if (!delegate) {
    throw new AppError("collection delegate not found", 500);
  }

  return { config, delegate };
}

function stripHiddenFields(record, config) {
  if (!record || typeof record !== "object") {
    return record;
  }

  const clone = { ...record };
  (config.hiddenFields || []).forEach((field) => {
    delete clone[field];
  });
  return clone;
}

function normalizeLogPayload(payload) {
  if (payload === undefined) {
    return null;
  }
  return payload;
}

function normalizeJsonPayload(payload, config) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppError("request body must be a JSON object", 400);
  }

  const nextPayload = { ...payload };
  delete nextPayload.id;
  delete nextPayload.createdAt;
  delete nextPayload.updatedAt;
  delete nextPayload.userName;
  delete nextPayload.userEmail;
  delete nextPayload.userFirmName;
  delete nextPayload.userSubscriptionPlan;
  delete nextPayload.userBillingCycle;
  delete nextPayload.user;

  (config.hiddenFields || []).forEach((field) => {
    delete nextPayload[field];
  });

  return nextPayload;
}

function formatRecordForResponse(item, config) {
  const stripped = stripHiddenFields(item, config);
  if (!stripped || typeof stripped !== "object") {
    return stripped;
  }
  if (config.key === "subscriptionPayments" && stripped.user) {
    return {
      ...stripped,
      userName: stripped.user.name || stripped.user.email || "-",
      userEmail: stripped.user.email || "-",
      userFirmName: stripped.user.firmName || "-",
      userSubscriptionPlan: stripped.user.subscriptionPlan || "TRIAL",
      userBillingCycle: stripped.user.billingCycle || "MONTHLY",
    };
  }
  return stripped;
}

function buildSearchWhere(config, search, searchField) {
  const term = String(search || "").trim();
  if (!term) {
    return {};
  }

  const searchFieldConfigs = config.searchFields || [];
  const allowedSearchFields = new Map(searchFieldConfigs.map((field) => [field.value, field]));
  const field = allowedSearchFields.has(searchField) ? searchField : null;
  const targetFields = field ? [allowedSearchFields.get(field)] : searchFieldConfigs;

  if (targetFields.length === 0) {
    return {};
  }

  return {
    OR: targetFields
      .map((fieldConfig) => {
        if (!fieldConfig?.value) {
          return null;
        }

        if (fieldConfig.relation) {
          const parts = fieldConfig.relation.split(".");
          if (parts.length === 2) {
            const [relName, relProp] = parts;
            return {
              [relName]: {
                [relProp]: {
                  contains: term,
                  mode: "insensitive",
                },
              },
            };
          }
        }

        if (fieldConfig.type === "number") {
          const numericValue = Number(term);
          if (Number.isFinite(numericValue)) {
            return { [fieldConfig.value]: numericValue };
          }
          return null;
        }

        if (fieldConfig.type === "boolean") {
          const normalized = term.toLowerCase();
          if (["true", "yes", "1"].includes(normalized)) {
            return { [fieldConfig.value]: true };
          }
          if (["false", "no", "0"].includes(normalized)) {
            return { [fieldConfig.value]: false };
          }
          return null;
        }

        return {
          [fieldConfig.value]: {
            contains: term,
            mode: "insensitive",
          },
        };
      })
      .filter(Boolean),
  };
}

function buildOrderBy(config, sortBy, sortOrder) {
  const allowed = new Set([...(config.sortableFields || []), ...(config.previewFields || []).map((field) => field.value)]);
  const field = allowed.has(sortBy) ? sortBy : (config.sortableFields || [])[0] || "createdAt";
  const direction = String(sortOrder || "desc").toLowerCase() === "asc" ? "asc" : "desc";
  return { [field]: direction };
}

async function logAdminAction(req, { action, collectionKey, recordId = null, beforeData = null, afterData = null, metadata = null }) {
  try {
    await prisma.adminActionLog.create({
      data: {
        userId: req.user.userId,
        action,
        collectionKey,
        recordId,
        beforeData: normalizeLogPayload(beforeData),
        afterData: normalizeLogPayload(afterData),
        metadata: normalizeLogPayload(metadata),
      },
    });
  } catch (_error) {
    // Never block admin operations on audit logging.
  }
}

const listCollections = asyncHandler(async (_req, res) => {
  const collections = getAdminCollectionKeys().map((key) => getAdminCollectionConfig(key));
  return res.json({ collections });
});

const listCollectionRecords = asyncHandler(async (req, res) => {
  const { collection } = req.params;
  const config = getCollectionConfigOrThrow(collection);
  const delegate = prisma[config.delegate];
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const search = String(req.query.search || "").trim();
  const searchField = String(req.query.searchField || "").trim();
  const sortBy = String(req.query.sortBy || "").trim();
  const sortOrder = String(req.query.sortOrder || "desc").trim();

  const where = buildSearchWhere(config, search, searchField);
  const findOptions = {
    where,
    orderBy: buildOrderBy(config, sortBy, sortOrder),
    skip: (page - 1) * limit,
    take: limit,
  };
  if (config.include) {
    findOptions.include = config.include;
  }

  const [items, total] = await Promise.all([
    delegate.findMany(findOptions),
    delegate.count({ where }),
  ]);

  return res.json({
    collection: config,
    items: items.map((item) => formatRecordForResponse(item, config)),
    pagination: {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    },
  });
});

const getCollectionRecord = asyncHandler(async (req, res) => {
  const { collection, id } = req.params;
  const { config, delegate } = getDelegate(collection);

  const findOptions = { where: { id } };
  if (config.include) {
    findOptions.include = config.include;
  }

  const record = await delegate.findUnique(findOptions);
  if (!record) {
    throw new AppError("record not found", 404);
  }

  return res.json({
    collection: config,
    item: formatRecordForResponse(record, config),
  });
});

const createCollectionRecord = asyncHandler(async (req, res) => {
  const { collection } = req.params;
  const { config, delegate } = getDelegate(collection);

  if (config.allowCreate === false) {
    throw new AppError("create is disabled for this collection", 403);
  }

  const data = normalizeJsonPayload(req.body, config);
  const created = await delegate.create({
    data,
    ...(config.include ? { include: config.include } : {}),
  });
  await logAdminAction(req, {
    action: "CREATE",
    collectionKey: config.key,
    recordId: created.id,
    afterData: created,
  });

  return res.status(201).json({
    collection: config,
    item: formatRecordForResponse(created, config),
  });
});

const updateCollectionRecord = asyncHandler(async (req, res) => {
  const { collection, id } = req.params;
  const { config, delegate } = getDelegate(collection);

  if (config.allowUpdate === false) {
    throw new AppError("update is disabled for this collection", 403);
  }

  const beforeData = await delegate.findUnique({ where: { id } });
  if (!beforeData) {
    throw new AppError("record not found", 404);
  }

  const data = normalizeJsonPayload(req.body, config);
  const updated = await delegate.update({
    where: { id },
    data,
    ...(config.include ? { include: config.include } : {}),
  });
  await logAdminAction(req, {
    action: "UPDATE",
    collectionKey: config.key,
    recordId: updated.id,
    beforeData,
    afterData: updated,
  });

  return res.json({
    collection: config,
    item: formatRecordForResponse(updated, config),
  });
});

const deleteCollectionRecord = asyncHandler(async (req, res) => {
  const { collection, id } = req.params;
  const { config, delegate } = getDelegate(collection);

  if (config.allowDelete === false) {
    throw new AppError("delete is disabled for this collection", 403);
  }

  const beforeData = await delegate.findUnique({ where: { id } });
  if (!beforeData) {
    throw new AppError("record not found", 404);
  }

  await delegate.delete({ where: { id } });
  await logAdminAction(req, {
    action: "DELETE",
    collectionKey: config.key,
    recordId: id,
    beforeData,
  });
  return res.json({ message: "record deleted" });
});

const adminUpdateUserSubscription = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    plan,
    billingCycle = "MONTHLY",
    status = "ACTIVE",
    durationDays,
    planExpiresAt,
    isLifetime,
    reason,
  } = req.body;

  const user = await prisma.user.findUnique({
    where: { id },
  });

  if (!user) {
    throw new AppError("User not found", 404);
  }

  const validPlans = ["TRIAL", "STARTER", "GROWTH", "PREMIUM"];
  const targetPlan = String(plan || "").toUpperCase();
  if (!validPlans.includes(targetPlan)) {
    throw new AppError(`Invalid plan: ${plan}. Allowed: ${validPlans.join(", ")}`, 400);
  }

  const validCycles = ["MONTHLY", "YEARLY", "LIFETIME"];
  const targetCycle = String(billingCycle || "MONTHLY").toUpperCase();
  if (!validCycles.includes(targetCycle)) {
    throw new AppError(`Invalid cycle: ${billingCycle}`, 400);
  }

  const validStatuses = ["ACTIVE", "EXPIRED", "CANCELLED"];
  const targetStatus = String(status || "ACTIVE").toUpperCase();
  if (!validStatuses.includes(targetStatus)) {
    throw new AppError(`Invalid status: ${status}`, 400);
  }

  // Calculate new expiration date
  let newExpiresAt = null;
  const now = new Date();

  if (isLifetime || targetCycle === "LIFETIME" || durationDays === "lifetime" || Number(durationDays) >= 36500) {
    // 100 years lifetime access
    newExpiresAt = new Date(now.getTime() + 100 * 365 * 24 * 60 * 60 * 1000);
  } else if (planExpiresAt) {
    const parsedDate = new Date(planExpiresAt);
    if (isNaN(parsedDate.getTime())) {
      throw new AppError("Invalid planExpiresAt date", 400);
    }
    newExpiresAt = parsedDate;
  } else if (durationDays && Number(durationDays) > 0) {
    newExpiresAt = new Date(now.getTime() + Number(durationDays) * 24 * 60 * 60 * 1000);
  } else if (targetPlan === "TRIAL") {
    newExpiresAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  } else {
    // Default based on cycle: 30 days for monthly, 365 days for yearly
    const days = targetCycle === "YEARLY" ? 365 : 30;
    newExpiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  }

  const updateData = {
    subscriptionPlan: targetPlan,
    billingCycle: targetCycle === "LIFETIME" ? "YEARLY" : targetCycle,
    subscriptionStatus: targetStatus,
    planExpiresAt: newExpiresAt,
  };

  if (targetPlan === "TRIAL") {
    updateData.trialEndsAt = newExpiresAt;
  }

  const updatedUser = await prisma.user.update({
    where: { id },
    data: updateData,
  });

  await logAdminAction(req, {
    action: "UPDATE_USER_SUBSCRIPTION",
    collectionKey: "users",
    recordId: user.id,
    beforeData: {
      subscriptionPlan: user.subscriptionPlan,
      billingCycle: user.billingCycle,
      subscriptionStatus: user.subscriptionStatus,
      planExpiresAt: user.planExpiresAt,
    },
    afterData: {
      subscriptionPlan: updatedUser.subscriptionPlan,
      billingCycle: updatedUser.billingCycle,
      subscriptionStatus: updatedUser.subscriptionStatus,
      planExpiresAt: updatedUser.planExpiresAt,
    },
    metadata: {
      reason: reason || "Admin complimentary / manual plan assignment",
      adminUserId: req.user.userId,
      isLifetime: Boolean(isLifetime || targetCycle === "LIFETIME"),
    },
  });

  const sanitized = { ...updatedUser };
  delete sanitized.password;

  return res.json({
    message: `Plan updated to ${targetPlan} successfully.`,
    user: sanitized,
  });
});

const toggleUserFreeAccess = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { enabled } = req.body;

  const user = await prisma.user.findUnique({
    where: { id },
  });

  if (!user) {
    throw new AppError("User not found", 404);
  }

  // If enabled is not a boolean, toggle the current state
  const isCurrentlyFree =
    user.subscriptionPlan === "COMPLIMENTARY" ||
    (user.subscriptionPlan === "PREMIUM" && user.billingCycle === "LIFETIME") ||
    (user.subscriptionPlan === "PREMIUM" && user.planExpiresAt === null && user.subscriptionStatus === "ACTIVE");
  const shouldEnable = typeof enabled === "boolean" ? enabled : !isCurrentlyFree;

  const updateData = shouldEnable
    ? {
        subscriptionPlan: "PREMIUM",
        billingCycle: "YEARLY",
        subscriptionStatus: "ACTIVE",
        planExpiresAt: null,
      }
    : {
        subscriptionPlan: "TRIAL",
        billingCycle: "MONTHLY",
        subscriptionStatus: "ACTIVE",
        planExpiresAt: null,
        trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      };

  const updatedUser = await prisma.user.update({
    where: { id },
    data: updateData,
  });

  await logAdminAction(req, {
    action: shouldEnable ? "ENABLE_VIP_ACCESS" : "DISABLE_VIP_ACCESS",
    collectionKey: "users",
    recordId: user.id,
    beforeData: {
      subscriptionPlan: user.subscriptionPlan,
      billingCycle: user.billingCycle,
      subscriptionStatus: user.subscriptionStatus,
      planExpiresAt: user.planExpiresAt,
    },
    afterData: {
      subscriptionPlan: updatedUser.subscriptionPlan,
      billingCycle: updatedUser.billingCycle,
      subscriptionStatus: updatedUser.subscriptionStatus,
      planExpiresAt: updatedUser.planExpiresAt,
    },
    metadata: {
      adminUserId: req.user.userId,
      isVipPremium: shouldEnable,
    },
  });

  const sanitized = { ...updatedUser };
  delete sanitized.password;

  return res.json({
    success: true,
    isComplimentary: shouldEnable,
    isVip: shouldEnable,
    message: shouldEnable
      ? `VIP Premium Yearly access enabled for ${user.name || user.email}.`
      : `VIP access disabled for ${user.name || user.email}. Reverted to trial.`,
    user: sanitized,
  });
});

module.exports = {
  listCollections,
  listCollectionRecords,
  getCollectionRecord,
  createCollectionRecord,
  updateCollectionRecord,
  deleteCollectionRecord,
  adminUpdateUserSubscription,
  toggleUserFreeAccess,
};
