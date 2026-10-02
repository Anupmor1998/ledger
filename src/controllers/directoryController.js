const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");

const getMarketDirectory = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const partyType = String(req.query.partyType || "buyer").toLowerCase(); // "buyer" or "seller"
  const qualityId = req.query.qualityId ? String(req.query.qualityId).trim() : "";
  const search = req.query.search ? String(req.query.search).trim().toLowerCase() : "";

  // 1. Fetch all qualities for user to populate quality selector and top qualities chips
  const allQualities = await prisma.quality.findMany({
    where: { userId },
    select: { id: true, name: true, isActive: true },
    orderBy: { name: "asc" },
  });

  // 2. Fetch quality order stats from non-cancelled orders
  const qualityOrderStats = await prisma.order.groupBy({
    by: ["qualityId"],
    where: {
      userId,
      status: { not: "CANCELLED" },
    },
    _count: {
      id: true,
    },
    _sum: {
      quantity: true,
    },
  });

  const statsMap = new Map();
  qualityOrderStats.forEach((s) => {
    statsMap.set(s.qualityId, {
      orderCount: s._count.id || 0,
      totalQuantity: Number(s._sum.quantity || 0),
    });
  });

  const qualitiesWithStats = allQualities.map((q) => {
    const stat = statsMap.get(q.id) || { orderCount: 0, totalQuantity: 0 };
    return {
      id: q.id,
      name: q.name,
      orderCount: stat.orderCount,
      totalQuantity: stat.totalQuantity,
    };
  });

  // Sort top qualities by orderCount descending
  const topQualities = [...qualitiesWithStats]
    .filter((q) => q.orderCount > 0)
    .sort((a, b) => b.orderCount - a.orderCount)
    .slice(0, 10);

  // If no qualityId is selected, return top qualities and general overview
  if (!qualityId) {
    return res.json({
      partyType,
      selectedQuality: null,
      topQualities,
      allQualities: qualitiesWithStats,
      parties: [],
      summary: {
        totalParties: 0,
        totalOrders: 0,
        lastMarketRate: 0,
        totalVolume: 0,
      },
    });
  }

  // Verify the selected quality exists
  const selectedQuality = allQualities.find((q) => q.id === qualityId);
  if (!selectedQuality) {
    throw new AppError("Selected quality not found", 404);
  }

  // Query non-cancelled orders for this quality
  const isBuyer = partyType === "buyer";
  const orders = await prisma.order.findMany({
    where: {
      userId,
      qualityId,
      status: { not: "CANCELLED" },
    },
    include: isBuyer ? { customer: true } : { manufacturer: true },
    orderBy: { orderDate: "desc" },
  });

  // Group by Customer (buyer) or Manufacturer (seller)
  const partyMap = new Map();
  let latestMarketRate = 0;
  let totalVolume = 0;

  for (const order of orders) {
    const party = isBuyer ? order.customer : order.manufacturer;
    if (!party) continue;

    const rateNum = Number(order.rate || 0);
    const qtyNum = Number(order.quantity || 0);
    const meterNum = Number(order.meter || 0);

    if (!latestMarketRate && rateNum > 0) {
      latestMarketRate = rateNum;
    }
    totalVolume += qtyNum;

    if (!partyMap.has(party.id)) {
      partyMap.set(party.id, {
        id: party.id,
        partyType: isBuyer ? "buyer" : "seller",
        name: party.name || "",
        firmName: party.firmName || "",
        phone: party.phone || "",
        email: party.email || "",
        address: party.address || "",
        lastOrderDate: order.orderDate,
        lastRate: rateNum,
        rates: [rateNum],
        orderCount: 1,
        totalQuantity: qtyNum,
        totalMeter: meterNum,
        quantityUnit: order.quantityUnit || "TAKKA",
      });
    } else {
      const existing = partyMap.get(party.id);
      existing.orderCount += 1;
      existing.totalQuantity += qtyNum;
      existing.totalMeter += meterNum;
      existing.rates.push(rateNum);
    }
  }

  let partyList = Array.from(partyMap.values()).map((p) => {
    const validRates = p.rates.filter((r) => r > 0);
    const avgRate =
      validRates.length > 0
        ? validRates.reduce((a, b) => a + b, 0) / validRates.length
        : p.lastRate;
    return {
      ...p,
      avgRate: Number(avgRate.toFixed(2)),
      rates: undefined,
    };
  });

  // Filter by search term if provided
  if (search) {
    partyList = partyList.filter(
      (p) =>
        p.firmName.toLowerCase().includes(search) ||
        p.name.toLowerCase().includes(search) ||
        p.phone.includes(search)
    );
  }

  // Sort by order count descending, then lastOrderDate descending
  partyList.sort((a, b) => {
    if (b.orderCount !== a.orderCount) {
      return b.orderCount - a.orderCount;
    }
    return new Date(b.lastOrderDate) - new Date(a.lastOrderDate);
  });

  return res.json({
    partyType,
    selectedQuality: {
      id: selectedQuality.id,
      name: selectedQuality.name,
    },
    topQualities,
    allQualities: qualitiesWithStats,
    parties: partyList,
    summary: {
      totalParties: partyList.length,
      totalOrders: orders.length,
      totalVolume,
      lastMarketRate: latestMarketRate,
    },
  });
});

module.exports = {
  getMarketDirectory,
};
