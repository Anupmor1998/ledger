const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const {
  buildPaginatedResponse,
  normalizeSearch,
  parsePagination,
  parseSort,
} = require("../utils/listQuery");
const { getFinancialYearStartYear } = require("../utils/financialYear");
const {
  PAYMENT_MODES,
  getSelectedFinancialYearStartForUser,
  getNextPaymentReceiptSerialNo,
  isPaymentReceiptSerialConflict,
  syncPendingPaymentAmounts,
} = require("../utils/payments");

const RECEIPT_SERIAL_RETRY_LIMIT = 3;
const PENDING_PAYMENT_SORT_FIELDS = [
  "serialNo",
  "accountName",
  "amountDue",
  "amountReceived",
  "balanceAmount",
  "status",
  "dueDate",
  "createdAt",
  "updatedAt",
];

function parseDateOrThrow(value, fieldName) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(`${fieldName} is invalid`, 400);
  }
  return date;
}

function normalizePendingPayment(row) {
  return {
    ...row,
    amountDue: Number(row.amountDue),
    amountReceived: Number(row.amountReceived),
    balanceAmount: Number(row.balanceAmount),
  };
}

const listPendingPayments = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const selectedFinancialYearStart = await getSelectedFinancialYearStartForUser(userId);
  const pagination = parsePagination(req.query);
  const { sortBy, sortOrder } = parseSort(
    req.query,
    PENDING_PAYMENT_SORT_FIELDS,
    "createdAt",
    "desc"
  );
  const search = normalizeSearch(req.query.search);
  const searchAsNumber = Number.parseInt(search || "", 10);
  const hasNumericSearch = Number.isFinite(searchAsNumber);

  const where = {
    userId,
    fyStartYear: selectedFinancialYearStart,
    ...(search
      ? {
          OR: [
            { accountName: { contains: search, mode: "insensitive" } },
            hasNumericSearch
              ? { serialNo: searchAsNumber }
              : undefined,
            { order: { customer: { name: { contains: search, mode: "insensitive" } } } },
            { order: { customer: { firmName: { contains: search, mode: "insensitive" } } } },
            hasNumericSearch ? { order: { orderNo: searchAsNumber } } : undefined,
          ].filter(Boolean),
        }
      : {}),
  };

  const rows = await prisma.pendingPayment.findMany({
    where,
    orderBy: { [sortBy]: sortOrder },
    skip: pagination.skip,
    take: pagination.take,
    include: {
      order: {
        select: {
          id: true,
          orderNo: true,
          orderDate: true,
          customer: { select: { id: true, name: true, firmName: true } },
        },
      },
    },
  });

  const normalized = rows.map(normalizePendingPayment);
  if (!pagination.enabled) {
    return res.json(normalized);
  }

  const total = await prisma.pendingPayment.count({ where });
  return res.json(buildPaginatedResponse(normalized, total, pagination.page, pagination.limit));
});

const receivePendingPayment = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const { date, paymentMode, amount, paymentReceivedDate } = req.body || {};

  if (!date || !paymentMode || amount === undefined || !paymentReceivedDate) {
    throw new AppError("date, paymentMode, amount and paymentReceivedDate are required", 400);
  }

  if (!Object.values(PAYMENT_MODES).includes(String(paymentMode).toUpperCase())) {
    throw new AppError("paymentMode must be one of: CASH, CHEQUE, ONLINE, UPI", 400);
  }

  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new AppError("amount must be greater than 0", 400);
  }

  const parsedDate = parseDateOrThrow(date, "date");
  const parsedReceivedDate = parseDateOrThrow(paymentReceivedDate, "paymentReceivedDate");
  const receiptFyStartYear = getFinancialYearStartYear(parsedDate);
  let createdReceipt;

  for (let attempt = 0; attempt < RECEIPT_SERIAL_RETRY_LIMIT; attempt += 1) {
    try {
      createdReceipt = await prisma.$transaction(async (tx) => {
        const pendingPayment = await tx.pendingPayment.findFirst({
          where: { id, userId },
          include: {
            order: { select: { orderNo: true } },
          },
        });

        if (!pendingPayment) {
          throw new AppError("pending payment not found", 404);
        }
        if (pendingPayment.status === "PAID") {
          throw new AppError("pending payment is already fully paid", 400);
        }

        const numericAmount = Number(amount);
        if (numericAmount > Number(pendingPayment.balanceAmount)) {
          throw new AppError("received amount cannot be greater than balance amount", 400);
        }

        const serialNo = await getNextPaymentReceiptSerialNo(tx, userId, receiptFyStartYear);
        const receipt = await tx.paymentReceipt.create({
          data: {
            userId,
            pendingPaymentId: pendingPayment.id,
            fyStartYear: receiptFyStartYear,
            serialNo,
            accountName: pendingPayment.accountName,
            date: parsedDate,
            paymentMode: String(paymentMode).toUpperCase(),
            amount: numericAmount,
            paymentReceivedDate: parsedReceivedDate,
          },
          include: {
            pendingPayment: {
              select: {
                id: true,
                serialNo: true,
                orderId: true,
                order: { select: { orderNo: true } },
              },
            },
          },
        });

        await syncPendingPaymentAmounts(tx, pendingPayment.id);
        return receipt;
      });
      break;
    } catch (error) {
      if (isPaymentReceiptSerialConflict(error) && attempt < RECEIPT_SERIAL_RETRY_LIMIT - 1) {
        continue;
      }
      throw error;
    }
  }

  return res.status(201).json({
    ...createdReceipt,
    amount: Number(createdReceipt.amount),
  });
});

module.exports = {
  listPendingPayments,
  receivePendingPayment,
};
