const prisma = require("../config/prisma");
const asyncHandler = require("../utils/asyncHandler");

const getHealth = asyncHandler(async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  return res.json({ status: "ok", db: "connected" });
});

module.exports = {
  getHealth,
};
