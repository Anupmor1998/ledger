const { getFinancialYearStartYear } = require("./financialYear");
const AppError = require("./appError");
const prisma = require("../config/prisma");

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function roundCurrency(value) {
  return Math.round(Number(value || 0));
}

function safeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function formatCellDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

function computeLotValue(order) {
  if (order.lot !== null && order.lot !== undefined && order.lot !== "") {
    return Math.round(safeNumber(order.lot));
  }
  const quantity = safeNumber(order.quantity);
  const unit = String(order.quantityUnit || "").toUpperCase();
  const lotMeters = safeNumber(order.lotMeters);

  if (unit === "LOT") {
    return Math.round(quantity);
  }
  if (unit === "TAKKA") {
    return Math.round(quantity / 12);
  }
  if (unit === "METER" && lotMeters > 0) {
    return Math.round(quantity / lotMeters);
  }
  return "";
}

function computeMeterValue(order) {
  const processed = safeNumber(order.processedMeter);
  if (processed > 0) return round2(processed);
  return round2(safeNumber(order.meter));
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

async function getNextPaymentEntrySerialNo(tx, userId, fyStartYear) {
  const latest = await tx.paymentEntry.findFirst({
    where: { userId, fyStartYear },
    orderBy: { serialNo: "desc" },
    select: { serialNo: true },
  });

  return (latest?.serialNo || 0) + 1;
}

function isPaymentEntrySerialConflict(error) {
  if (error?.code !== "P2002") return false;
  const target = error?.meta?.target;
  if (Array.isArray(target)) {
    return (
      target.includes("userId") &&
      target.includes("fyStartYear") &&
      target.includes("serialNo")
    );
  }
  return String(target || "").includes(
    "PaymentEntry_userId_fyStartYear_serialNo_key",
  );
}

function computeOrderFullCommission(order, customerConfig) {
  const stored = roundCurrency(order?.commissionAmount);
  if (stored > 0) {
    return stored;
  }

  const quantity = Number(order?.quantity || 0);
  const rate = Number(order?.rate || 0);
  const quantityUnit = String(order?.quantityUnit || "TAKKA").toUpperCase();
  const lotMeters = Number(order?.lotMeters || 0);
  const customer = customerConfig || order?.customer;

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !Number.isFinite(rate) ||
    rate <= 0
  ) {
    return 0;
  }

  const commissionBase = String(
    customer?.commissionBase || "PERCENT",
  ).toUpperCase();
  const commissionPercent =
    Number(customer?.commissionPercent) > 0
      ? Number(customer?.commissionPercent)
      : 1;
  const commissionLotRate = Number(customer?.commissionLotRate || 0);

  if (commissionBase === "LOT") {
    let lotQuantity = quantity;
    if (quantityUnit === "TAKKA") lotQuantity = quantity / 12;
    else if (quantityUnit === "METER" && lotMeters > 0)
      lotQuantity = quantity / lotMeters;
    return Math.round(lotQuantity * commissionLotRate);
  }

  let meter = Number(order?.meter || 0);
  if (!meter || meter <= 0) {
    if (quantityUnit === "METER") meter = quantity;
    else if (quantityUnit === "LOT" && lotMeters > 0)
      meter = quantity * lotMeters;
    else if (lotMeters > 0) meter = quantity * (lotMeters / 12);
  }
  const baseAmount = meter * rate;
  const gstAmount = baseAmount * 0.05;
  return Math.round((baseAmount + gstAmount) * (commissionPercent / 100));
}

module.exports = {
  round2,
  roundCurrency,
  safeNumber,
  formatCellDate,
  computeLotValue,
  computeMeterValue,
  computeOrderFullCommission,
  getSelectedFinancialYearStartForUser,
  getNextPaymentEntrySerialNo,
  isPaymentEntrySerialConflict,
};
