const prisma = require("../config/prisma");

async function getHealth(_req, res) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ status: "ok", db: "connected" });
  } catch (error) {
    return res.status(500).json({ status: "error", db: "not connected", message: error.message });
  }
}

module.exports = {
  getHealth,
};
