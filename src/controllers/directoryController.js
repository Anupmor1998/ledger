const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");

const getMarketDirectory = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const partyType = String(req.query.partyType || "buyer").toLowerCase(); // "buyer" or "seller"
  const qualityId = req.query.qualityId ? String(req.query.qualityId).trim() : "";
  const qualitySearch = req.query.qualitySearch ? String(req.query.qualitySearch).trim() : "";
  const search = req.query.search ? String(req.query.search).trim().toLowerCase() : "";

  // 1. Fetch all qualities for user
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

  // If neither qualityId nor qualitySearch is provided, return discovery overview
  if (!qualityId && !qualitySearch) {
    return res.json({
      partyType,
      selectedQuality: null,
      matchedQualities: [],
      qualitySearch: "",
      topQualities,
      allQualities: qualitiesWithStats,
      parties: [],
      summary: {
        totalParties: 0,
        totalOrders: 0,
        lastMarketRate: 0,
        totalVolume: 0,
        matchedQualitiesCount: 0,
      },
    });
  }

  // 3. Determine matched qualities:
  // If specific qualityId is provided, match that single quality.
  // Otherwise, match all qualities whose names contain qualitySearch (case-insensitive substring/partial match).
  let matchedQualities = [];
  if (qualityId) {
    const exact = qualitiesWithStats.find((q) => q.id === qualityId);
    if (exact) {
      matchedQualities = [exact];
    }
  } else if (qualitySearch) {
    const term = qualitySearch.toLowerCase();
    matchedQualities = qualitiesWithStats.filter((q) =>
      q.name.toLowerCase().includes(term)
    );
  }

  // If no matching qualities found for the search term
  if (matchedQualities.length === 0) {
    return res.json({
      partyType,
      selectedQuality: null,
      matchedQualities: [],
      qualitySearch,
      topQualities,
      allQualities: qualitiesWithStats,
      parties: [],
      summary: {
        totalParties: 0,
        totalOrders: 0,
        lastMarketRate: 0,
        totalVolume: 0,
        matchedQualitiesCount: 0,
      },
    });
  }

  const matchedQualityIds = matchedQualities.map((q) => q.id);
  const isBuyer = partyType === "buyer";

  // 4. Query non-cancelled orders for any of the matched qualities
  const orders = await prisma.order.findMany({
    where: {
      userId,
      qualityId: { in: matchedQualityIds },
      status: { not: "CANCELLED" },
    },
    include: {
      quality: {
        select: { id: true, name: true },
      },
      ...(isBuyer ? { customer: true } : { manufacturer: true }),
    },
    orderBy: { orderDate: "desc" },
  });

  // 5. Aggregate by Customer (buyer) or Manufacturer (seller)
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

    const qName = order.quality?.name || "";

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
        qualityDeals: qName ? { [qName]: 1 } : {},
      });
    } else {
      const existing = partyMap.get(party.id);
      existing.orderCount += 1;
      existing.totalQuantity += qtyNum;
      existing.totalMeter += meterNum;
      existing.rates.push(rateNum);
      if (qName) {
        existing.qualityDeals[qName] = (existing.qualityDeals[qName] || 0) + 1;
      }
    }
  }

  let partyList = Array.from(partyMap.values()).map((p) => {
    const validRates = p.rates.filter((r) => r > 0);
    const avgRate =
      validRates.length > 0
        ? validRates.reduce((a, b) => a + b, 0) / validRates.length
        : p.lastRate;

    const tradedQualities = Object.entries(p.qualityDeals || {}).map(([name, count]) => ({
      name,
      count,
    }));

    return {
      ...p,
      avgRate: Number(avgRate.toFixed(2)),
      rates: undefined,
      qualityDeals: undefined,
      qualities: tradedQualities,
    };
  });

  // Filter by party search term if provided
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
    qualitySearch,
    selectedQuality: matchedQualities.length === 1 ? matchedQualities[0] : null,
    matchedQualities,
    topQualities,
    allQualities: qualitiesWithStats,
    parties: partyList,
    summary: {
      totalParties: partyList.length,
      totalOrders: orders.length,
      totalVolume,
      lastMarketRate: latestMarketRate,
      matchedQualitiesCount: matchedQualities.length,
    },
  });
});

module.exports = {
  getMarketDirectory,
};
