const { Prisma } = require("@prisma/client");
const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const { getFinancialYearStartYear, getFinancialYearLabel } = require("../utils/financialYear");

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatMonthKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function formatMonthLabel(date) {
  return date.toLocaleString("en-IN", { month: "short", year: "numeric" });
}

function formatDayLabel(date) {
  return date.toLocaleString("en-IN", { day: "2-digit", month: "short" });
}

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

function getAnchorDate(fyBounds) {
  const now = new Date();
  if (now < fyBounds.start) {
    return fyBounds.start;
  }
  if (now > fyBounds.end) {
    return fyBounds.end;
  }
  return now;
}

function buildDailyBuckets(anchorDate, fyBounds) {
  const buckets = [];
  const counts = new Map();
  const start = new Date(anchorDate);
  start.setDate(start.getDate() - 13);
  if (start < fyBounds.start) {
    start.setTime(fyBounds.start.getTime());
  }

  const cursor = new Date(start);
  while (cursor <= anchorDate) {
    const key = formatDateKey(cursor);
    buckets.push({ key, label: formatDayLabel(cursor), value: 0 });
    counts.set(key, buckets[buckets.length - 1]);
    cursor.setDate(cursor.getDate() + 1);
  }

  return { buckets, counts, start };
}

function buildMonthlyBuckets(anchorDate, fyBounds) {
  const buckets = [];
  const counts = new Map();
  const start = new Date(anchorDate.getFullYear(), anchorDate.getMonth() - 11, 1);
  if (start < fyBounds.start) {
    start.setTime(new Date(fyBounds.start.getFullYear(), fyBounds.start.getMonth(), 1).getTime());
  }

  const cursor = new Date(start);
  cursor.setDate(1);
  while (cursor <= anchorDate) {
    const key = formatMonthKey(cursor);
    buckets.push({ key, label: formatMonthLabel(cursor), value: 0 });
    counts.set(key, buckets[buckets.length - 1]);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return { buckets, counts, start };
}

async function getSelectedFinancialYearStartForUser(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { selectedFinancialYearStart: true },
  });

  if (!user) {
    throw new AppError("user not found", 404);
  }

  return user.selectedFinancialYearStart ?? getFinancialYearStartYear();
}

const getDashboardSummary = require("../utils/asyncHandler")(async (req, res) => {
  const userSelectedFinancialYearStart = await getSelectedFinancialYearStartForUser(req.user.userId);
  const requestedFinancialYearStart = req.query?.fyStartYear
    ? Number(req.query.fyStartYear)
    : userSelectedFinancialYearStart;
  if (!Number.isInteger(requestedFinancialYearStart)) {
    throw new AppError("fyStartYear must be a valid financial year start", 400);
  }

  const availableFinancialYearsRaw = await prisma.order.findMany({
    where: { userId: req.user.userId },
    distinct: ["fyStartYear"],
    orderBy: { fyStartYear: "asc" },
    select: { fyStartYear: true },
  });
  const availableFinancialYears = Array.from(
    new Set([
      ...availableFinancialYearsRaw.map((row) => row.fyStartYear),
      userSelectedFinancialYearStart,
      requestedFinancialYearStart,
    ])
  ).sort((a, b) => a - b);

  const selectedFinancialYearStart = requestedFinancialYearStart;
  const fyBounds = getFinancialYearBounds(selectedFinancialYearStart);
  const anchorDate = getAnchorDate(fyBounds);
  const { buckets: dailyBuckets, counts: dailyCounts } = buildDailyBuckets(anchorDate, fyBounds);
  const { buckets: monthlyBuckets, counts: monthlyCounts } = buildMonthlyBuckets(
    anchorDate,
    fyBounds
  );

  const fyOrders = await prisma.order.findMany({
    where: {
      userId: req.user.userId,
      fyStartYear: selectedFinancialYearStart,
      orderDate: {
        gte: fyBounds.start,
        lte: anchorDate,
      },
    },
    select: {
      orderDate: true,
      status: true,
      commissionAmount: true,
      lot: true,
      quantity: true,
      quantityUnit: true,
      lotMeters: true,
    },
  });

  let pendingOrderCount = 0;
  let completedOrderCount = 0;
  let cancelledOrderCount = 0;
  let pendingCommissionAmount = 0;
  let completedCommissionAmount = 0;
  let cancelledCommissionAmount = 0;
  let totalLotInFinancialYear = 0;

  fyOrders.forEach((order) => {
    const orderDate = new Date(order.orderDate);
    const dailyKey = formatDateKey(orderDate);
    const monthlyKey = formatMonthKey(orderDate);
    const status = String(order.status || "").toUpperCase();
    const commissionAmount = Number(order.commissionAmount || 0);
    const lotValue = computeLotValue(order);

    if (dailyCounts.has(dailyKey)) {
      dailyCounts.get(dailyKey).value += lotValue;
    }
    if (monthlyCounts.has(monthlyKey)) {
      monthlyCounts.get(monthlyKey).value += lotValue;
    }
    totalLotInFinancialYear += lotValue;

    if (status === "PENDING") {
      pendingOrderCount += 1;
      pendingCommissionAmount += commissionAmount;
    } else if (status === "COMPLETED") {
      completedOrderCount += 1;
      completedCommissionAmount += commissionAmount;
    } else if (status === "CANCELLED") {
      cancelledOrderCount += 1;
      cancelledCommissionAmount += commissionAmount;
    }
  });

  const pendingCommissionSummary = await prisma.pendingPayment.aggregate({
    where: {
      userId: req.user.userId,
      fyStartYear: selectedFinancialYearStart,
      balanceAmount: {
        gt: 0,
      },
    },
    _sum: {
      balanceAmount: true,
    },
  });

  const openPendingCommissionAmount = Number(pendingCommissionSummary._sum.balanceAmount || 0);
  const totalCommissionAmount =
    openPendingCommissionAmount + completedCommissionAmount + cancelledCommissionAmount;

  const yearlyStart = Math.max(selectedFinancialYearStart - 4, getFinancialYearStartYear());
  const yearlyOrdersSource = await prisma.order.findMany({
    where: {
      userId: req.user.userId,
      fyStartYear: {
        gte: yearlyStart,
        lte: selectedFinancialYearStart,
      },
    },
    select: {
      fyStartYear: true,
      lot: true,
      quantity: true,
      quantityUnit: true,
      lotMeters: true,
    },
  });

  const yearlyMap = new Map();
  for (let fy = yearlyStart; fy <= selectedFinancialYearStart; fy += 1) {
    yearlyMap.set(fy, 0);
  }

  yearlyOrdersSource.forEach((order) => {
    const fy = Number(order.fyStartYear);
    if (!yearlyMap.has(fy)) {
      return;
    }
    yearlyMap.set(fy, yearlyMap.get(fy) + computeLotValue(order));
  });
  const yearlyOrders = [];
  for (let fy = yearlyStart; fy <= selectedFinancialYearStart; fy += 1) {
    yearlyOrders.push({
      label: getFinancialYearLabel(fy),
      value: yearlyMap.get(fy) || 0,
    });
  }

  res.json({
    financialYearStart: selectedFinancialYearStart,
    userSelectedFinancialYearStart,
    financialYearLabel: getFinancialYearLabel(selectedFinancialYearStart),
    availableFinancialYears: availableFinancialYears.map((fy) => ({
      startYear: fy,
      label: getFinancialYearLabel(fy),
    })),
    totalOrdersInFinancialYear: fyOrders.length,
    totalLotInFinancialYear,
    pendingOrderCount,
    completedOrderCount,
    cancelledOrderCount,
    pendingCommissionAmount: Math.round(openPendingCommissionAmount),
    completedCommissionAmount: Math.round(completedCommissionAmount),
    cancelledCommissionAmount: Math.round(cancelledCommissionAmount),
    totalCommissionAmount: Math.round(totalCommissionAmount),
    dailyLots: dailyBuckets,
    monthlyLots: monthlyBuckets,
    yearlyOrders,
    dailyOrders: dailyBuckets,
    monthlyOrders: monthlyBuckets,
  });
});

module.exports = {
  getDashboardSummary,
};
