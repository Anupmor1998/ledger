const logger = require("../utils/logger");

function requestLogger(req, res, next) {
  const startedAt = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const level =
      res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";

    logger[level]("HTTP request completed", {
      feature: "http",
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs,
      userId: req.user?.userId || null,
      ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
      origin: req.headers.origin || null,
      userAgent: req.headers["user-agent"] || null,
    });
  });

  next();
}

module.exports = requestLogger;
