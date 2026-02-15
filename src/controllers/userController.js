const prisma = require("../config/prisma");

async function listUsers(_req, res) {
  try {
    const users = await prisma.user.findMany({
      orderBy: { id: "asc" },
      select: { id: true, email: true, name: true, createdAt: true, updatedAt: true },
    });

    return res.json(users);
  } catch (error) {
    return res.status(500).json({ message: "failed to fetch users", detail: error.message });
  }
}

module.exports = {
  listUsers,
};
