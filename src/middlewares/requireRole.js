const AppError = require("../utils/appError");

function requireRole(...allowedRoles) {
  const normalizedAllowedRoles = allowedRoles.map((role) => String(role || "").toUpperCase());

  return function roleMiddleware(req, _res, next) {
    const role = String(req.user?.role || "").toUpperCase();

    if (!role || !normalizedAllowedRoles.includes(role)) {
      return next(new AppError("forbidden", 403));
    }

    return next();
  };
}

module.exports = requireRole;
