const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const {
  getFinancialYearStartYear,
  getFinancialYearLabel,
} = require("../utils/financialYear");

function computeLotValue(order) {
  if (order?.lot !== null && order?.lot !== undefined && order?.lot !== "") {
    return Math.round(Number(order.lot) || 0);
  }

  const quantity = Number(order?.quantity || 0);
  const unit = String(order?.quantityUnit || "").toUpperCase();
  const lotMeters = Number(order?.lotMeters || 0);

  if (unit === "LOT") {
    return Math.round(quantity);
  }
  if (unit === "TAKKA") {
    return Math.round(quantity / 12);
  }
  if (unit === "METER" && lotMeters > 0) {
    return Math.round(quantity / lotMeters);
  }
  return 0;
}

function getFinancialYearBounds(startYear) {
  const year = Number(startYear);
  if (!Number.isInteger(year)) {
    throw new AppError("selected financial year is invalid", 400);
  }

  return {
    start: new Date(year, 3, 1, 0, 0, 0, 0),
    end: new Date(year + 1, 2, 31, 23, 59, 59, 999),
  };
}

function formatMonthLabel(date) {
  return date.toLocaleString("en-IN", { month: "short", year: "numeric" });
}

function formatMonthKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getFinancialYearMonths(startYear) {
  const months = [];
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(startYear, 3 + i, 1);
    const key = formatMonthKey(d);
    const label = formatMonthLabel(d);
    months.push({ key, label });
  }
  return months;
}

function buildTopParties(orders, partyKey, limit = 10) {
  const partyMap = new Map();

  orders.forEach((order) => {
    const party = order[partyKey];
    if (!party) {
      return;
    }

    const partyId = party.id;
    if (!partyMap.has(partyId)) {
      partyMap.set(partyId, {
        id: partyId,
        firmName: party.firmName || "",
        name: party.name || "",
        totalLot: 0,
        totalOrders: 0,
        totalCommission: 0,
      });
    }

    const entry = partyMap.get(partyId);
    entry.totalLot += computeLotValue(order);
    entry.totalOrders += 1;
    entry.totalCommission += Math.round(Number(order.commissionAmount || 0));
  });

  return [...partyMap.values()]
    .sort((a, b) => b.totalLot - a.totalLot)
    .slice(0, limit)
    .map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));
}

function buildDecliningCustomers(
  currentOrders,
  previousOrders,
  limit = null,
  prevLabel = "",
) {
  if (!previousOrders || previousOrders.length === 0) {
    return [];
  }

  const prevMap = new Map();
  previousOrders.forEach((order) => {
    const customer = order.customer;
    if (!customer) {
      return;
    }

    const customerId = customer.id;
    if (!prevMap.has(customerId)) {
      prevMap.set(customerId, {
        id: customerId,
        firmName: customer.firmName || "",
        name: customer.name || "",
        previousMonthLot: 0,
        previousMonthOrders: 0,
      });
    }

    const entry = prevMap.get(customerId);
    entry.previousMonthLot += computeLotValue(order);
    entry.previousMonthOrders += 1;
  });

  const currMap = new Map();
  currentOrders.forEach((order) => {
    const customer = order.customer;
    if (!customer) {
      return;
    }

    const customerId = customer.id;
    if (!currMap.has(customerId)) {
      currMap.set(customerId, {
        currentMonthLot: 0,
        currentMonthOrders: 0,
      });
    }

    const entry = currMap.get(customerId);
    entry.currentMonthLot += computeLotValue(order);
    entry.currentMonthOrders += 1;
  });

  const declining = [];

  prevMap.forEach((prevEntry, customerId) => {
    if (prevEntry.previousMonthLot <= 0) {
      return;
    }

    const currEntry = currMap.get(customerId) || {
      currentMonthLot: 0,
      currentMonthOrders: 0,
    };

    if (currEntry.currentMonthLot < prevEntry.previousMonthLot) {
      const dropPercent = Math.round(
        ((prevEntry.previousMonthLot - currEntry.currentMonthLot) /
          prevEntry.previousMonthLot) *
          100,
      );

      declining.push({
        id: prevEntry.id,
        firmName: prevEntry.firmName,
        name: prevEntry.name,
        previousMonthLot: prevEntry.previousMonthLot,
        currentMonthLot: currEntry.currentMonthLot,
        previousMonthOrders: prevEntry.previousMonthOrders,
        currentMonthOrders: currEntry.currentMonthOrders,
        dropPercent,
        prevLabel,
      });
    }
  });

  const sorted = declining.sort((a, b) => b.dropPercent - a.dropPercent);
  return limit ? sorted.slice(0, limit) : sorted;
}

function buildCommissionTrend(orders, fyMonths, anchorDate) {
  const bucketMap = new Map();

  fyMonths.forEach((m) => {
    bucketMap.set(m.key, {
      key: m.key,
      label: m.label,
      commission: 0,
      orders: 0,
      lot: 0,
    });
  });

  orders.forEach((order) => {
    const orderDate = new Date(order.orderDate);
    const key = formatMonthKey(orderDate);
    const commission = Math.round(Number(order.commissionAmount || 0));
    const lot = computeLotValue(order);

    if (bucketMap.has(key)) {
      const bucket = bucketMap.get(key);
      bucket.commission += commission;
      bucket.orders += 1;
      bucket.lot += lot;
    }
  });

  // Filter up to anchorDate
  const anchorKey = formatMonthKey(anchorDate);
  const result = [];
  for (const m of fyMonths) {
    result.push(bucketMap.get(m.key));
    if (m.key === anchorKey) {
      break;
    }
  }

  return result;
}

function buildKeyMetrics(orders) {
  const totalOrders = orders.length;
  const nonCancelledOrders = orders.filter(
    (o) => String(o.status || "").toUpperCase() !== "CANCELLED",
  );
  const completedOrders = orders.filter(
    (o) => String(o.status || "").toUpperCase() === "COMPLETED",
  );

  const completionRate =
    nonCancelledOrders.length > 0
      ? Math.round(
          (completedOrders.length / nonCancelledOrders.length) * 1000,
        ) / 10
      : 0;

  const totalCommission = orders.reduce(
    (sum, o) => sum + Math.round(Number(o.commissionAmount || 0)),
    0,
  );
  const avgOrderValue =
    totalOrders > 0 ? Math.round(totalCommission / totalOrders) : 0;

  const customerSet = new Set();
  const customerOrderCount = new Map();
  const manufacturerSet = new Set();

  orders.forEach((order) => {
    if (order.customerId) {
      customerSet.add(order.customerId);
      customerOrderCount.set(
        order.customerId,
        (customerOrderCount.get(order.customerId) || 0) + 1,
      );
    }
    if (order.manufacturerId) {
      manufacturerSet.add(order.manufacturerId);
    }
  });

  const totalCustomersServed = customerSet.size;
  const totalManufacturersUsed = manufacturerSet.size;

  let repeatCustomerCount = 0;
  customerOrderCount.forEach((count) => {
    if (count > 1) {
      repeatCustomerCount += 1;
    }
  });

  const repeatCustomerRate =
    totalCustomersServed > 0
      ? Math.round((repeatCustomerCount / totalCustomersServed) * 1000) / 10
      : 0;

  return {
    completionRate,
    avgOrderValue,
    totalCustomersServed,
    totalManufacturersUsed,
    repeatCustomerRate,
  };
}

const getAnalytics = asyncHandler(async (req, res) => {
  const requestedFyStart = req.query?.fyStartYear
    ? Number(req.query.fyStartYear)
    : getFinancialYearStartYear();

  if (!Number.isInteger(requestedFyStart)) {
    throw new AppError("fyStartYear must be a valid financial year start", 400);
  }

  const fyBounds = getFinancialYearBounds(requestedFyStart);
  const now = new Date();
  const anchorDate =
    now > fyBounds.end
      ? fyBounds.end
      : now < fyBounds.start
        ? fyBounds.start
        : now;

  const orderSelect = {
    id: true,
    orderDate: true,
    status: true,
    commissionAmount: true,
    lot: true,
    quantity: true,
    quantityUnit: true,
    lotMeters: true,
    customerId: true,
    manufacturerId: true,
    customer: {
      select: {
        id: true,
        firmName: true,
        name: true,
      },
    },
    manufacturer: {
      select: {
        id: true,
        firmName: true,
        name: true,
      },
    },
  };

  const fyOrders = await prisma.order.findMany({
    where: {
      userId: req.user.userId,
      fyStartYear: requestedFyStart,
      orderDate: {
        gte: fyBounds.start,
        lte: fyBounds.end,
      },
    },
    select: orderSelect,
  });

  const fyMonths = getFinancialYearMonths(requestedFyStart);

  // Group orders by month key
  const ordersByMonth = new Map();
  fyMonths.forEach((m) => ordersByMonth.set(m.key, []));

  fyOrders.forEach((order) => {
    const key = formatMonthKey(new Date(order.orderDate));
    if (ordersByMonth.has(key)) {
      ordersByMonth.get(key).push(order);
    }
  });

  // Filter months up to anchorDate so future months are not included
  const anchorKey = formatMonthKey(anchorDate);
  const elapsedMonths = [];
  for (const m of fyMonths) {
    elapsedMonths.push(m);
    if (m.key === anchorKey) {
      break;
    }
  }

  // Top Customers for each elapsed month and full year
  const topCustomers = {
    all: buildTopParties(fyOrders, "customer", 10),
  };
  const topManufacturers = {
    all: buildTopParties(fyOrders, "manufacturer", 10),
  };

  elapsedMonths.forEach((m) => {
    const monthOrders = ordersByMonth.get(m.key) || [];
    topCustomers[m.key] = buildTopParties(monthOrders, "customer", 10);
    topManufacturers[m.key] = buildTopParties(monthOrders, "manufacturer", 10);
  });

  // Declining Customers: only for elapsed months from index 1 vs previous month
  const decliningCustomers = {};
  for (let i = 1; i < elapsedMonths.length; i += 1) {
    const curr = elapsedMonths[i];
    const prev = elapsedMonths[i - 1];
    decliningCustomers[curr.key] = buildDecliningCustomers(
      ordersByMonth.get(curr.key) || [],
      ordersByMonth.get(prev.key) || [],
      null,
      prev.label,
    );
  }

  // Determine default active month key
  const currentMonthKey = formatMonthKey(now);
  let defaultMonthKey = "all";
  if (
    ordersByMonth.has(currentMonthKey) &&
    elapsedMonths.some((m) => m.key === currentMonthKey)
  ) {
    defaultMonthKey = currentMonthKey;
  } else if (elapsedMonths.length > 0) {
    defaultMonthKey = elapsedMonths[elapsedMonths.length - 1].key;
  }

  // Default declining month key: latest elapsed month with a comparison
  const defaultDecliningMonthKey =
    elapsedMonths.length > 1 ? elapsedMonths[elapsedMonths.length - 1].key : "";

  const commissionTrend = buildCommissionTrend(fyOrders, fyMonths, anchorDate);
  const keyMetrics = buildKeyMetrics(fyOrders);

  res.json({
    financialYearStart: requestedFyStart,
    financialYearLabel: getFinancialYearLabel(requestedFyStart),
    availableMonths: [
      {
        key: "all",
        label: `Full Year (${getFinancialYearLabel(requestedFyStart)})`,
      },
      ...elapsedMonths,
    ],
    comparisonMonths: elapsedMonths.slice(1).map((m, idx) => ({
      key: m.key,
      label: `${m.label} (vs ${elapsedMonths[idx].label})`,
      currLabel: m.label,
      prevLabel: elapsedMonths[idx].label,
    })),
    defaultMonthKey,
    defaultDecliningMonthKey,
    topCustomers,
    topManufacturers,
    decliningCustomers,
    commissionTrend,
    keyMetrics,
  });
});

module.exports = {
  getAnalytics,
};
