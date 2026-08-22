const { verifyToken } = require("../utils/jwt");
const prisma = require("../config/prisma");
const AppError = require("../utils/appError");

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(new AppError("missing or invalid authorization header", 401));
  }

  const token = authHeader.slice("Bearer ".length);

  try {
    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        theme: true,
        selectedFinancialYearStart: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return next(new AppError("user not found", 404));
    }

    req.user = {
      ...payload,
      ...user,
      userId: user.id,
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = authMiddleware;
