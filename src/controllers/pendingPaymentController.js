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
  PENDING_PAYMENT_STATUS,
  getSelectedFinancialYearStartForUser,
  getNextPaymentReceiptSerialNo,
  isPaymentReceiptSerialConflict,
  round2,
  syncPendingPaymentAmounts,
} = require("../utils/payments");

const RECEIPT_SERIAL_RETRY_LIMIT = 3;
const PENDING_PAYMENT_SORT_FIELDS = [
  "serialNo",
  "accountName",
  "amountDue",
  "amountReceived",
  "discountAmount",
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
    finalSettledAmount:
      row.finalSettledAmount === null ? null : Number(row.finalSettledAmount),
    discountAmount: Number(row.discountAmount || 0),
    discountPercent: Number(row.discountPercent || 0),
    balanceAmount: Number(row.balanceAmount),
  };
}

function getCustomerDisplayName(customer) {
  return String(customer?.firmName || customer?.name || "").trim();
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
  const statusFilter = req.query.status ? String(req.query.status).toUpperCase() : null;
  if (
    statusFilter &&
    ![
      PENDING_PAYMENT_STATUS.PENDING,
      PENDING_PAYMENT_STATUS.PARTIAL,
      PENDING_PAYMENT_STATUS.PAID,
      PENDING_PAYMENT_STATUS.SETTLED,
    ].includes(statusFilter)
  ) {
    throw new AppError("status must be one of: PENDING, PARTIAL, PAID, SETTLED", 400);
  }
  const dueFrom = req.query.dueFrom ? new Date(String(req.query.dueFrom)) : null;
  const dueTo = req.query.dueTo ? new Date(String(req.query.dueTo)) : null;
  if (dueFrom && Number.isNaN(dueFrom.getTime())) {
    throw new AppError("invalid dueFrom date", 400);
  }
  if (dueTo && Number.isNaN(dueTo.getTime())) {
    throw new AppError("invalid dueTo date", 400);
  }

  const where = {
    userId,
    fyStartYear: selectedFinancialYearStart,
    status: statusFilter
      ? statusFilter
      : {
          in: [PENDING_PAYMENT_STATUS.PENDING, PENDING_PAYMENT_STATUS.PARTIAL],
        },
    ...(dueFrom || dueTo
      ? {
          dueDate: {
            ...(dueFrom ? { gte: dueFrom } : {}),
            ...(dueTo ? { lte: dueTo } : {}),
          },
        }
      : {}),
    ...(search
      ? {
          OR: [
            { accountName: { contains: search, mode: "insensitive" } },
            hasNumericSearch ? { serialNo: searchAsNumber } : undefined,
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

  const normalized = rows.map((row) =>
    normalizePendingPayment({
      ...row,
      customerId: row.order?.customer?.id || null,
      customerDisplayName: getCustomerDisplayName(row.order?.customer),
    })
  );
  if (!pagination.enabled) {
    return res.json(normalized);
  }

  const total = await prisma.pendingPayment.count({ where });
  return res.json(buildPaginatedResponse(normalized, total, pagination.page, pagination.limit));
});

const createBulkPendingPaymentReceipt = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { date, paymentMode, paymentReceivedDate, entries } = req.body || {};

  if (!date || !paymentMode || !paymentReceivedDate || !Array.isArray(entries) || entries.length === 0) {
    throw new AppError("date, paymentMode, paymentReceivedDate and entries are required", 400);
  }

  if (!Object.values(PAYMENT_MODES).includes(String(paymentMode).toUpperCase())) {
    throw new AppError("paymentMode must be one of: CASH, CHEQUE, ONLINE, UPI", 400);
  }

  const parsedDate = parseDateOrThrow(date, "date");
  const parsedReceivedDate = parseDateOrThrow(paymentReceivedDate, "paymentReceivedDate");
  const receiptFyStartYear = getFinancialYearStartYear(parsedDate);

  const normalizedEntries = entries.map((entry) => ({
    pendingPaymentId: String(entry?.pendingPaymentId || "").trim(),
    allocatedAmount: Number(entry?.allocatedAmount),
    isFinalSettlement: Boolean(entry?.isFinalSettlement),
  }));

  if (normalizedEntries.some((entry) => !entry.pendingPaymentId)) {
    throw new AppError("every selected payment must include pendingPaymentId", 400);
  }
  if (new Set(normalizedEntries.map((entry) => entry.pendingPaymentId)).size !== normalizedEntries.length) {
    throw new AppError("duplicate pending payments are not allowed in one receipt", 400);
  }
  if (normalizedEntries.some((entry) => !Number.isFinite(entry.allocatedAmount) || entry.allocatedAmount <= 0)) {
    throw new AppError("allocatedAmount must be greater than 0 for every selected payment", 400);
  }

  let createdReceipt;

  for (let attempt = 0; attempt < RECEIPT_SERIAL_RETRY_LIMIT; attempt += 1) {
    try {
      createdReceipt = await prisma.$transaction(async (tx) => {
        const pendingPayments = await tx.pendingPayment.findMany({
          where: {
            id: { in: normalizedEntries.map((entry) => entry.pendingPaymentId) },
            userId,
            status: {
              in: [PENDING_PAYMENT_STATUS.PENDING, PENDING_PAYMENT_STATUS.PARTIAL],
            },
          },
          include: {
            order: {
              select: {
                orderNo: true,
                customer: { select: { id: true, name: true, firmName: true } },
              },
            },
          },
        });

        if (pendingPayments.length !== normalizedEntries.length) {
          throw new AppError("one or more selected pending payments were not found", 404);
        }

        const paymentById = new Map(pendingPayments.map((item) => [item.id, item]));
        const customerIds = new Set(
          pendingPayments.map((item) => String(item.order?.customer?.id || ""))
        );

        if (customerIds.size !== 1) {
          throw new AppError("selected pending payments must belong to the same customer", 400);
        }

        const preparedAllocations = normalizedEntries.map((entry) => {
          const pendingPayment = paymentById.get(entry.pendingPaymentId);
          const balanceAmount = Number(pendingPayment.balanceAmount || 0);

          if (entry.allocatedAmount > balanceAmount) {
            throw new AppError(
              `allocated amount cannot be greater than balance for pending ${pendingPayment.serialNo}`,
              400
            );
          }

          return {
            pendingPaymentId: pendingPayment.id,
            allocatedAmount: round2(entry.allocatedAmount),
            isFinalSettlement: entry.isFinalSettlement,
          };
        });

        const totalAmount = round2(
          preparedAllocations.reduce((sum, entry) => sum + entry.allocatedAmount, 0)
        );

        const accountName = getCustomerDisplayName(pendingPayments[0].order?.customer);
        const serialNo = await getNextPaymentReceiptSerialNo(tx, userId, receiptFyStartYear);
        const receipt = await tx.paymentReceipt.create({
          data: {
            userId,
            fyStartYear: receiptFyStartYear,
            serialNo,
            accountName,
            date: parsedDate,
            paymentMode: String(paymentMode).toUpperCase(),
            amount: totalAmount,
            paymentReceivedDate: parsedReceivedDate,
          },
        });

        await tx.paymentAllocation.createMany({
          data: preparedAllocations.map((entry) => ({
            userId,
            paymentReceiptId: receipt.id,
            pendingPaymentId: entry.pendingPaymentId,
            allocatedAmount: entry.allocatedAmount,
            isFinalSettlement: entry.isFinalSettlement,
          })),
        });

        for (const entry of preparedAllocations) {
          await syncPendingPaymentAmounts(tx, entry.pendingPaymentId);
        }

        return tx.paymentReceipt.findUnique({
          where: { id: receipt.id },
          include: {
            paymentAllocations: {
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
            },
          },
        });
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
    paymentAllocations: (createdReceipt.paymentAllocations || []).map((allocation) => ({
      ...allocation,
      allocatedAmount: Number(allocation.allocatedAmount),
    })),
  });
});

module.exports = {
  listPendingPayments,
  createBulkPendingPaymentReceipt,
};
