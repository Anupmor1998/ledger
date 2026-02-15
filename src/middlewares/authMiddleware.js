const { verifyToken } = require("../utils/jwt");
const AppError = require("../utils/appError");

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(new AppError("missing or invalid authorization header", 401));
  }

  const token = authHeader.slice("Bearer ".length);

  try {
    req.user = verifyToken(token);
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = authMiddleware;
