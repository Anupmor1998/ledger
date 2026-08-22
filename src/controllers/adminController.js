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

  (config.hiddenFields || []).forEach((field) => {
    delete nextPayload[field];
  });

  return nextPayload;
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
  const [items, total] = await Promise.all([
    delegate.findMany({
      where,
      orderBy: buildOrderBy(config, sortBy, sortOrder),
      skip: (page - 1) * limit,
      take: limit,
    }),
    delegate.count({ where }),
  ]);

  return res.json({
    collection: config,
    items: items.map((item) => stripHiddenFields(item, config)),
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

  const record = await delegate.findUnique({ where: { id } });
  if (!record) {
    throw new AppError("record not found", 404);
  }

  return res.json({
    collection: config,
    item: stripHiddenFields(record, config),
  });
});

const createCollectionRecord = asyncHandler(async (req, res) => {
  const { collection } = req.params;
  const { config, delegate } = getDelegate(collection);

  if (config.allowCreate === false) {
    throw new AppError("create is disabled for this collection", 403);
  }

  const data = normalizeJsonPayload(req.body, config);
  const created = await delegate.create({ data });
  await logAdminAction(req, {
    action: "CREATE",
    collectionKey: config.key,
    recordId: created.id,
    afterData: created,
  });

  return res.status(201).json({
    collection: config,
    item: stripHiddenFields(created, config),
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
    item: stripHiddenFields(updated, config),
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

module.exports = {
  listCollections,
  listCollectionRecords,
  getCollectionRecord,
  createCollectionRecord,
  updateCollectionRecord,
  deleteCollectionRecord,
};
