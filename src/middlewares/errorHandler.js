const AppError = require("../utils/appError");

function mapPrismaError(error) {
  if (!error?.code) {
    return null;
  }

  if (error.code === "P2002") {
    const targets = Array.isArray(error.meta?.target) ? error.meta.target.join(", ") : "unique field";
    return new AppError(`${targets} already exists`, 409);
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

function errorHandler(error, _req, res, _next) {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({ message: error.message });
  }

  const prismaError = mapPrismaError(error);
  if (prismaError) {
    return res.status(prismaError.statusCode).json({ message: prismaError.message });
  }

  if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
    return res.status(401).json({ message: "invalid or expired token" });
  }

  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ message: "invalid JSON payload" });
  }

  return res.status(500).json({
    message: "internal server error",
    detail: error.message,
  });
}

module.exports = {
  notFoundHandler,
  errorHandler,
};
