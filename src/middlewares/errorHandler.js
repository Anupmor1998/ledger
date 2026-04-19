const AppError = require("../utils/appError");
const logger = require("../utils/logger");

const ACRONYM_LABELS = {
  gst: "GST",
  gstin: "GSTIN",
  id: "ID",
  no: "No",
  url: "URL",
};

function toTitleCase(value) {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (ACRONYM_LABELS[lower]) {
        return ACRONYM_LABELS[lower];
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function extractFieldName(rawTarget) {
  const target = String(rawTarget || "").trim();
  if (!target) return "field";

  // e.g. public.Customer.email -> email
  if (target.includes(".")) {
    return target.split(".").pop();
  }

  // e.g. Customer_email_key -> email, Order_customerId_key -> customerId
  if (target.endsWith("_key")) {
    const parts = target.replace(/_key$/i, "").split("_").filter(Boolean);
    if (parts.length >= 2) {
      return parts.slice(1).join("_");
    }
  }

  return target;
}

function humanizeFieldLabel(rawField) {
  const fieldName = extractFieldName(rawField);

  // camelCase -> camel Case
  const spaced = fieldName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();

  return toTitleCase(spaced || "field");
}

function buildUniqueMessage(error) {
  const targets = Array.isArray(error.meta?.target)
    ? error.meta.target
    : error.meta?.target
      ? [error.meta.target]
      : [];

  if (!targets.length) {
    return "This value already exists. Please use a different value.";
  }

  const readableFields = [...new Set(targets.map(humanizeFieldLabel))];

  if (readableFields.length === 1) {
    return `${readableFields[0]} already exists. Please use a different value.`;
  }

  return `${readableFields.join(", ")} combination already exists. Please use different values.`;
}

function mapPrismaError(error) {
  if (!error?.code) {
    return null;
  }

  if (error.code === "P2002") {
    return new AppError(buildUniqueMessage(error), 409);
  }

  if (error.code === "P2003") {
    return new AppError("operation blocked by related records", 409);
  }

  if (error.code === "P2025") {
    return new AppError("record not found", 404);
  }

  return null;
}

function notFoundHandler(req, _res, next) {
  next(new AppError(`route not found: ${req.method} ${req.originalUrl}`, 404));
}

function errorHandler(error, req, res, _next) {
  if (error instanceof AppError) {
    logger.warn("Handled application error", {
      feature: "api",
      method: req.method,
      path: req.originalUrl,
      statusCode: error.statusCode,
      message: error.message,
    });
    return res.status(error.statusCode).json({ message: error.message });
  }

  const prismaError = mapPrismaError(error);
  if (prismaError) {
    logger.warn("Handled prisma error", {
      feature: "api",
      method: req.method,
      path: req.originalUrl,
      statusCode: prismaError.statusCode,
      message: prismaError.message,
      code: error.code,
    });
    return res.status(prismaError.statusCode).json({ message: prismaError.message });
  }

  if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
    logger.warn("Handled auth token error", {
      feature: "api",
      method: req.method,
      path: req.originalUrl,
      statusCode: 401,
      name: error.name,
      message: error.message,
    });
    return res.status(401).json({ message: "invalid or expired token" });
  }

  if (error instanceof SyntaxError && "body" in error) {
    logger.warn("Handled JSON payload error", {
      feature: "api",
      method: req.method,
      path: req.originalUrl,
      statusCode: 400,
      message: error.message,
    });
    return res.status(400).json({ message: "invalid JSON payload" });
  }

  logger.error("Unhandled server error", {
    feature: "api",
    method: req.method,
    path: req.originalUrl,
    error,
  });

  return res.status(500).json({
    message: "internal server error",
    detail: error.message,
  });
}

module.exports = {
  notFoundHandler,
  errorHandler,
};
