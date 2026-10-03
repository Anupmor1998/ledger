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
        tradedPartiesCount: 0,
        taggedPartiesCount: 0,
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
        tradedPartiesCount: 0,
        taggedPartiesCount: 0,
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

  // 5. Query explicitly tagged parties for any of the matched qualities
  const taggedPartyQualities = isBuyer
    ? await prisma.customerQuality.findMany({
        where: {
          userId,
          qualityId: { in: matchedQualityIds },
        },
        include: {
          customer: true,
          quality: { select: { id: true, name: true } },
        },
      })
    : await prisma.manufacturerQuality.findMany({
        where: {
          userId,
          qualityId: { in: matchedQualityIds },
        },
        include: {
          manufacturer: true,
          quality: { select: { id: true, name: true } },
        },
      });

  // 6. Aggregate by Customer (buyer) or Manufacturer (seller)
  const partyMap = new Map();
  let latestMarketRate = 0;
  let totalVolume = 0;

  // Process historical orders
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
        isTagged: false,
        taggedNotes: "",
        taggedQualities: [],
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

  // Process explicitly tagged parties
  for (const tq of taggedPartyQualities) {
    const party = isBuyer ? tq.customer : tq.manufacturer;
    if (!party) continue;

    const qName = tq.quality?.name || "";

    if (!partyMap.has(party.id)) {
      partyMap.set(party.id, {
        id: party.id,
        partyType: isBuyer ? "buyer" : "seller",
        name: party.name || "",
        firmName: party.firmName || "",
        phone: party.phone || "",
        email: party.email || "",
        address: party.address || "",
        lastOrderDate: null,
        lastRate: 0,
        rates: [],
        orderCount: 0,
        totalQuantity: 0,
        totalMeter: 0,
        quantityUnit: "TAKKA",
        qualityDeals: {},
        isTagged: true,
        taggedNotes: tq.notes || "",
        taggedQualities: qName ? [qName] : [],
      });
    } else {
      const existing = partyMap.get(party.id);
      existing.isTagged = true;
      if (tq.notes && !existing.taggedNotes) {
        existing.taggedNotes = tq.notes;
      }
      if (qName) {
        if (!existing.taggedQualities.includes(qName)) {
          existing.taggedQualities.push(qName);
        }
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

  // Sort order:
  // 1. Parties with past deals sorted by orderCount descending, then lastOrderDate descending
  // 2. Tagged parties with 0 orders sorted by firmName/name ascending
  partyList.sort((a, b) => {
    if (a.orderCount > 0 && b.orderCount === 0) return -1;
    if (a.orderCount === 0 && b.orderCount > 0) return 1;
    if (a.orderCount > 0 && b.orderCount > 0) {
      if (b.orderCount !== a.orderCount) {
        return b.orderCount - a.orderCount;
      }
      return new Date(b.lastOrderDate) - new Date(a.lastOrderDate);
    }
    const nameA = a.firmName || a.name || "";
    const nameB = b.firmName || b.name || "";
    return nameA.localeCompare(nameB);
  });

  const tradedCount = partyList.filter((p) => p.orderCount > 0).length;
  const taggedOnlyCount = partyList.filter((p) => p.orderCount === 0 && p.isTagged).length;

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
      tradedPartiesCount: tradedCount,
      taggedPartiesCount: taggedOnlyCount,
      totalOrders: orders.length,
      totalVolume,
      lastMarketRate: latestMarketRate,
      matchedQualitiesCount: matchedQualities.length,
    },
  });
});

// Tag a Customer or Manufacturer with a Quality they manufacture or purchase
const tagPartyQuality = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const {
    partyType,
    partyId,
    newParty,
    qualityId,
    newQualityName,
    notes,
  } = req.body;

  if (!partyType) {
    throw new AppError("partyType is required", 400);
  }

  const isBuyer = String(partyType).toLowerCase() === "buyer";

  // 1. Resolve or Create Quality
  let resolvedQuality = null;
  if (qualityId) {
    resolvedQuality = await prisma.quality.findFirst({
      where: { id: qualityId, userId },
    });
  }

  if (!resolvedQuality && newQualityName) {
    const qName = String(newQualityName).trim();
    if (qName) {
      resolvedQuality = await prisma.quality.findFirst({
        where: { userId, name: { equals: qName, mode: "insensitive" } },
      });
      if (!resolvedQuality) {
        resolvedQuality = await prisma.quality.create({
          data: {
            userId,
            name: qName,
            isActive: true,
          },
        });
      }
    }
  }

  if (!resolvedQuality) {
    throw new AppError("Please select or enter a valid fabric quality", 400);
  }

  // 2. Resolve or Create Party
  let resolvedParty = null;
  if (isBuyer) {
    if (partyId) {
      resolvedParty = await prisma.customer.findFirst({
        where: { id: partyId, userId },
      });
      if (!resolvedParty) {
        throw new AppError("Customer not found", 404);
      }
    } else if (newParty) {
      const firmName = String(newParty.firmName || "").trim();
      const personName = String(newParty.name || "").trim();
      const rawPhone = String(newParty.phone || "").trim();
      const cleanPhone = rawPhone.replace(/\D/g, "");
      const address = String(newParty.address || "").trim() || "-";

      if (!firmName && !personName) {
        throw new AppError("Firm name or contact name is required for new customer", 400);
      }
      if (!cleanPhone) {
        throw new AppError("Phone number is required for new customer", 400);
      }
      if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
        throw new AppError("Please enter a valid 10-digit Indian mobile number", 400);
      }

      resolvedParty = await prisma.customer.create({
        data: {
          userId,
          firmName: firmName || personName,
          name: personName || firmName,
          phone: cleanPhone,
          address,
          email: newParty.email ? String(newParty.email).trim() : null,
          commissionBase: "PERCENT",
          commissionPercent: 1,
        },
      });
    } else {
      throw new AppError("Please select or enter a customer", 400);
    }

    const record = await prisma.customerQuality.upsert({
      where: {
        userId_customerId_qualityId: {
          userId,
          customerId: resolvedParty.id,
          qualityId: resolvedQuality.id,
        },
      },
      create: {
        userId,
        customerId: resolvedParty.id,
        qualityId: resolvedQuality.id,
        notes: notes ? String(notes).trim() : null,
      },
      update: {
        notes: notes !== undefined ? (notes ? String(notes).trim() : null) : undefined,
      },
      include: {
        customer: true,
        quality: true,
      },
    });

    return res.status(201).json({
      message: `Tagged ${resolvedParty.firmName || resolvedParty.name} for quality ${resolvedQuality.name}`,
      tag: record,
      party: resolvedParty,
      quality: resolvedQuality,
    });
  } else {
    // Seller / Manufacturer
    if (partyId) {
      resolvedParty = await prisma.manufacturer.findFirst({
        where: { id: partyId, userId },
      });
      if (!resolvedParty) {
        throw new AppError("Manufacturer not found", 404);
      }
    } else if (newParty) {
      const firmName = String(newParty.firmName || "").trim();
      const personName = String(newParty.name || "").trim();
      const rawPhone = String(newParty.phone || "").trim();
      const cleanPhone = rawPhone.replace(/\D/g, "");
      const address = String(newParty.address || "").trim() || null;

      if (!firmName && !personName) {
        throw new AppError("Firm name or contact name is required for new manufacturer", 400);
      }
      if (!cleanPhone) {
        throw new AppError("Phone number is required for new manufacturer", 400);
      }
      if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
        throw new AppError("Please enter a valid 10-digit Indian mobile number", 400);
      }

      resolvedParty = await prisma.manufacturer.create({
        data: {
          userId,
          name: personName || firmName,
          firmName: firmName || null,
          phone: cleanPhone,
          address,
          email: newParty.email ? String(newParty.email).trim() : null,
        },
      });
    } else {
      throw new AppError("Please select or enter a manufacturer", 400);
    }

    const record = await prisma.manufacturerQuality.upsert({
      where: {
        userId_manufacturerId_qualityId: {
          userId,
          manufacturerId: resolvedParty.id,
          qualityId: resolvedQuality.id,
        },
      },
      create: {
        userId,
        manufacturerId: resolvedParty.id,
        qualityId: resolvedQuality.id,
        notes: notes ? String(notes).trim() : null,
      },
      update: {
        notes: notes !== undefined ? (notes ? String(notes).trim() : null) : undefined,
      },
      include: {
        manufacturer: true,
        quality: true,
      },
    });

    return res.status(201).json({
      message: `Tagged ${resolvedParty.firmName || resolvedParty.name} for quality ${resolvedQuality.name}`,
      tag: record,
      party: resolvedParty,
      quality: resolvedQuality,
    });
  }
});

// Untag a Customer or Manufacturer from a Quality
const untagPartyQuality = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const partyType = String(req.query.partyType || req.body.partyType || "").toLowerCase();
  const partyId = String(req.query.partyId || req.body.partyId || "").trim();
  const qualityId = String(req.query.qualityId || req.body.qualityId || "").trim();

  if (!partyType || !partyId || !qualityId) {
    throw new AppError("partyType, partyId, and qualityId are required", 400);
  }

  const isBuyer = partyType === "buyer";

  if (isBuyer) {
    await prisma.customerQuality.deleteMany({
      where: {
        userId,
        customerId: partyId,
        qualityId,
      },
    });
  } else {
    await prisma.manufacturerQuality.deleteMany({
      where: {
        userId,
        manufacturerId: partyId,
        qualityId,
      },
    });
  }

  return res.json({
    message: "Quality association removed successfully",
  });
});

module.exports = {
  getMarketDirectory,
  tagPartyQuality,
  untagPartyQuality,
};

