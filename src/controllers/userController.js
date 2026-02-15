const prisma = require("../config/prisma");
const asyncHandler = require("../utils/asyncHandler");

const listUsers = asyncHandler(async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { id: "asc" },
    select: { id: true, email: true, name: true, createdAt: true, updatedAt: true },
  });

  return res.json(users);
});

module.exports = {
  listUsers,
};
