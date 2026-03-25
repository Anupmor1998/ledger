const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const { getFinancialYearStartYear } = require("../utils/financialYear");
const {
  buildPaginatedResponse,
  normalizeSearch,
  parsePagination,
  parseSort,
} = require("../utils/listQuery");

const PAYMENT_MODES = {
  CASH: "CASH",
  CHEQUE: "CHEQUE",
  ONLINE: "ONLINE",
  UPI: "UPI",
};
const SERIAL_RETRY_LIMIT = 3;

function parseDateOrThrow(value, fieldName) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(`${fieldName} is invalid`, 400);
  }
  return date;
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

async function getNextSerialNo(tx, userId, fyStartYear) {
  const latest = await tx.paymentReceipt.findFirst({
    where: { userId, fyStartYear },
    orderBy: { serialNo: "desc" },
    select: { serialNo: true },
  });

  return (latest?.serialNo || 0) + 1;
}

function isSerialUniqueConflict(error) {
  if (error?.code !== "P2002") return false;
  const target = error?.meta?.target;
  if (Array.isArray(target)) {
    return (
      target.includes("userId") &&
      target.includes("fyStartYear") &&
      target.includes("serialNo")
    );
  }
  return String(target || "").includes("PaymentReceipt_userId_fyStartYear_serialNo_key");
}

const RECEIPT_SORT_FIELDS = [
  "serialNo",
  "accountName",
  "date",
  "paymentMode",
  "amount",
  "paymentReceivedDate",
  "createdAt",
  "updatedAt",
];

const createPaymentReceipt = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { accountName, date, paymentMode, amount, paymentReceivedDate } = req.body || {};

  if (!accountName || !date || !paymentMode || amount === undefined || !paymentReceivedDate) {
    throw new AppError(
      "accountName, date, paymentMode, amount and paymentReceivedDate are required",
      400
    );
  }

  if (!Object.values(PAYMENT_MODES).includes(String(paymentMode).toUpperCase())) {
    throw new AppError("paymentMode must be one of: CASH, CHEQUE, ONLINE, UPI", 400);
  }

  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new AppError("amount must be greater than 0", 400);
  }

  const parsedDate = parseDateOrThrow(date, "date");
  const parsedReceivedDate = parseDateOrThrow(paymentReceivedDate, "paymentReceivedDate");
  const fyStartYear = getFinancialYearStartYear(parsedDate);

  let created;
  for (let attempt = 0; attempt < SERIAL_RETRY_LIMIT; attempt += 1) {
    try {
      created = await prisma.$transaction(async (tx) => {
        const serialNo = await getNextSerialNo(tx, userId, fyStartYear);
        return tx.paymentReceipt.create({
          data: {
            userId,
            fyStartYear,
            serialNo,
            accountName: String(accountName).trim(),
            date: parsedDate,
            paymentMode: String(paymentMode).toUpperCase(),
            amount: Number(amount),
            paymentReceivedDate: parsedReceivedDate,
          },
        });
      });
      break;
    } catch (error) {
      if (isSerialUniqueConflict(error) && attempt < SERIAL_RETRY_LIMIT - 1) {
        continue;
      }
      throw error;
    }
  }

  return res.status(201).json({
    ...created,
    amount: Number(created.amount),
  });
});

const listPaymentReceipts = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const selectedFinancialYearStart = await getSelectedFinancialYearStartForUser(userId);
  const pagination = parsePagination(req.query);
  const { sortBy, sortOrder } = parseSort(req.query, RECEIPT_SORT_FIELDS, "date", "desc");
  const search = normalizeSearch(req.query.search);

  const where = {
    userId,
    fyStartYear: selectedFinancialYearStart,
    ...(search
      ? {
          OR: [
            { accountName: { contains: search, mode: "insensitive" } },
            Number.isFinite(Number.parseInt(search, 10))
              ? { serialNo: Number.parseInt(search, 10) }
              : undefined,
            Object.values(PAYMENT_MODES).includes(String(search).toUpperCase())
              ? { paymentMode: String(search).toUpperCase() }
              : undefined,
          ].filter(Boolean),
        }
      : {}),
  };

  const receipts = await prisma.paymentReceipt.findMany({
    where,
    orderBy: { [sortBy]: sortOrder },
    skip: pagination.skip,
    take: pagination.take,
  });

  const normalized = receipts.map((receipt) => ({
    ...receipt,
    amount: Number(receipt.amount),
  }));

  if (!pagination.enabled) {
    return res.json(normalized);
  }

  const total = await prisma.paymentReceipt.count({ where });
  return res.json(buildPaginatedResponse(normalized, total, pagination.page, pagination.limit));
});

const getPaymentReceiptById = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  const receipt = await prisma.paymentReceipt.findFirst({
    where: { id, userId },
  });

  if (!receipt) {
    throw new AppError("payment receipt not found", 404);
  }

  return res.json({
    ...receipt,
    amount: Number(receipt.amount),
  });
});

const updatePaymentReceipt = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const { accountName, date, paymentMode, amount, paymentReceivedDate } = req.body || {};

  if (
    accountName === undefined &&
    date === undefined &&
    paymentMode === undefined &&
    amount === undefined &&
    paymentReceivedDate === undefined
  ) {
    throw new AppError("at least one field is required", 400);
  }

  if (
    paymentMode !== undefined &&
    !Object.values(PAYMENT_MODES).includes(String(paymentMode).toUpperCase())
  ) {
    throw new AppError("paymentMode must be one of: CASH, CHEQUE, ONLINE, UPI", 400);
  }

  if (amount !== undefined && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
    throw new AppError("amount must be greater than 0", 400);
  }

  const existing = await prisma.paymentReceipt.findFirst({
    where: { id, userId },
    select: { id: true, fyStartYear: true, date: true },
  });

  if (!existing) {
    throw new AppError("payment receipt not found", 404);
  }

  const nextDate = date !== undefined ? parseDateOrThrow(date, "date") : existing.date;
  const nextFyStartYear = getFinancialYearStartYear(nextDate);

  let updated;
  for (let attempt = 0; attempt < SERIAL_RETRY_LIMIT; attempt += 1) {
    try {
      updated = await prisma.$transaction(async (tx) => {
        const data = {};

        if (accountName !== undefined) {
          const normalizedAccountName = String(accountName).trim();
          if (!normalizedAccountName) {
            throw new AppError("accountName cannot be empty", 400);
          }
          data.accountName = normalizedAccountName;
        }
        if (date !== undefined) {
          data.date = nextDate;
        }
        if (paymentMode !== undefined) {
          data.paymentMode = String(paymentMode).toUpperCase();
        }
        if (amount !== undefined) {
          data.amount = Number(amount);
        }
        if (paymentReceivedDate !== undefined) {
          data.paymentReceivedDate = parseDateOrThrow(paymentReceivedDate, "paymentReceivedDate");
        }

        if (nextFyStartYear !== existing.fyStartYear) {
          data.fyStartYear = nextFyStartYear;
          data.serialNo = await getNextSerialNo(tx, userId, nextFyStartYear);
        }

        return tx.paymentReceipt.update({
          where: { id },
          data,
        });
      });
      break;
    } catch (error) {
      if (isSerialUniqueConflict(error) && attempt < SERIAL_RETRY_LIMIT - 1) {
        continue;
      }
      throw error;
    }
  }

  return res.json({
    ...updated,
    amount: Number(updated.amount),
  });
});

const deletePaymentReceipt = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;
  const deleted = await prisma.paymentReceipt.deleteMany({
    where: { id, userId },
  });

  if (deleted.count === 0) {
    throw new AppError("payment receipt not found", 404);
  }

  return res.status(204).send();
});

module.exports = {
  createPaymentReceipt,
  listPaymentReceipts,
  getPaymentReceiptById,
  updatePaymentReceipt,
  deletePaymentReceipt,
  PAYMENT_MODES,
};
