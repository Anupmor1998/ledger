const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseSortOrder(value) {
  return String(value || "").toLowerCase() === "asc" ? "asc" : "desc";
}

function parsePagination(query) {
  const hasPagination = query.page !== undefined || query.limit !== undefined;

  if (!hasPagination) {
    return {
      enabled: false,
      page: null,
      limit: null,
      skip: undefined,
      take: undefined,
    };
  }

  const page = parsePositiveInt(query.page, DEFAULT_PAGE);
  const limit = Math.min(parsePositiveInt(query.limit, DEFAULT_LIMIT), MAX_LIMIT);

  return {
    enabled: true,
    page,
    limit,
    skip: (page - 1) * limit,
    take: limit,
  };
}

function normalizeSearch(value) {
  const normalized = String(value || "").trim();
  return normalized.length > 0 ? normalized : null;
}

function parseSort(query, allowedSortFields, defaultSortBy, defaultSortOrder = "desc") {
  const requestedSortBy = query.sortBy;
  const sortBy = allowedSortFields.includes(requestedSortBy) ? requestedSortBy : defaultSortBy;
  const sortOrder = parseSortOrder(query.sortOrder || defaultSortOrder);
  return { sortBy, sortOrder };
}

function buildPaginatedResponse(items, total, page, limit) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    items,
    pagination: {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  };
}

module.exports = {
  buildPaginatedResponse,
  normalizeSearch,
  parsePagination,
  parseSort,
};
