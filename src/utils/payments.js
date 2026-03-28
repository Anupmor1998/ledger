const prisma = require("../config/prisma");
const AppError = require("./appError");
const { getFinancialYearStartYear } = require("./financialYear");

const PAYMENT_MODES = {
  CASH: "CASH",
  CHEQUE: "CHEQUE",
  ONLINE: "ONLINE",
  UPI: "UPI",
};

const PENDING_PAYMENT_STATUS = {
  PENDING: "PENDING",
  PARTIAL: "PARTIAL",
  PAID: "PAID",
  SETTLED: "SETTLED",
};

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function roundPercent(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function getPendingPaymentStatus({
  amountDue,
  amountReceived,
  discountAmount = 0,
  hasFinalSettlement = false,
}) {
  const due = round2(amountDue);
  const received = round2(amountReceived);
  const discount = round2(discountAmount);
  const remaining = round2(due - received - discount);

  if (remaining <= 0 && due > 0) {
    return discount > 0 || hasFinalSettlement
      ? PENDING_PAYMENT_STATUS.SETTLED
      : PENDING_PAYMENT_STATUS.PAID;
  }
  if (received > 0) {
    return PENDING_PAYMENT_STATUS.PARTIAL;
  }
  return PENDING_PAYMENT_STATUS.PENDING;
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

async function getNextPendingPaymentSerialNo(tx, userId, fyStartYear) {
  const latest = await tx.pendingPayment.findFirst({
    where: { userId, fyStartYear },
    orderBy: { serialNo: "desc" },
    select: { serialNo: true },
  });

  return (latest?.serialNo || 0) + 1;
}

async function getNextPaymentReceiptSerialNo(tx, userId, fyStartYear) {
  const latest = await tx.paymentReceipt.findFirst({
    where: { userId, fyStartYear },
    orderBy: { serialNo: "desc" },
    select: { serialNo: true },
  });

  return (latest?.serialNo || 0) + 1;
}

function isPendingPaymentSerialConflict(error) {
  if (error?.code !== "P2002") return false;
  const target = error?.meta?.target;
  if (Array.isArray(target)) {
    return target.includes("userId") && target.includes("fyStartYear") && target.includes("serialNo");
  }
  return String(target || "").includes("PendingPayment_userId_fyStartYear_serialNo_key");
}

function isPaymentReceiptSerialConflict(error) {
  if (error?.code !== "P2002") return false;
  const target = error?.meta?.target;
  if (Array.isArray(target)) {
    return target.includes("userId") && target.includes("fyStartYear") && target.includes("serialNo");
  }
  return String(target || "").includes("PaymentReceipt_userId_fyStartYear_serialNo_key");
}

async function syncPendingPaymentAmounts(tx, pendingPaymentId) {
  const pendingPayment = await tx.pendingPayment.findUnique({
    where: { id: pendingPaymentId },
    select: { id: true, amountDue: true },
  });

  if (!pendingPayment) {
    throw new AppError("pending payment not found", 404);
  }

  const allocations = await tx.paymentAllocation.findMany({
    where: { pendingPaymentId },
    select: {
      allocatedAmount: true,
      isFinalSettlement: true,
    },
  });

  const amountDue = round2(pendingPayment.amountDue);
  const amountReceived = round2(
    allocations.reduce((sum, allocation) => sum + Number(allocation.allocatedAmount || 0), 0)
  );
  const hasFinalSettlement = allocations.some((allocation) => allocation.isFinalSettlement);
  const discountAmount = hasFinalSettlement
    ? round2(Math.max(amountDue - amountReceived, 0))
    : 0;
  const finalSettledAmount = hasFinalSettlement ? round2(amountReceived) : null;
  const balanceAmount = hasFinalSettlement
    ? 0
    : round2(Math.max(amountDue - amountReceived, 0));
  const discountPercent =
    amountDue > 0 ? roundPercent((discountAmount / amountDue) * 100) : 0;
  const status = getPendingPaymentStatus({
    amountDue,
    amountReceived,
    discountAmount,
    hasFinalSettlement,
  });

  return tx.pendingPayment.update({
    where: { id: pendingPaymentId },
    data: {
      amountReceived,
      finalSettledAmount,
      discountAmount,
      discountPercent,
      balanceAmount,
      status,
      settledAt:
        status === PENDING_PAYMENT_STATUS.PAID || status === PENDING_PAYMENT_STATUS.SETTLED
          ? new Date()
          : null,
    },
  });
}

module.exports = {
  PAYMENT_MODES,
  PENDING_PAYMENT_STATUS,
  round2,
  getPendingPaymentStatus,
  getSelectedFinancialYearStartForUser,
  getNextPendingPaymentSerialNo,
  getNextPaymentReceiptSerialNo,
  isPendingPaymentSerialConflict,
  isPaymentReceiptSerialConflict,
  syncPendingPaymentAmounts,
};
