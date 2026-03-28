const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const {
  buildPaginatedResponse,
  normalizeSearch,
  parsePagination,
  parseSort,
} = require("../utils/listQuery");
const {
  PAYMENT_MODES,
  getSelectedFinancialYearStartForUser,
  syncPendingPaymentAmounts,
} = require("../utils/payments");

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

function normalizeReceipt(receipt) {
  return {
    ...receipt,
    amount: Number(receipt.amount),
    paymentAllocations: (receipt.paymentAllocations || []).map((allocation) => ({
      ...allocation,
      allocatedAmount: Number(allocation.allocatedAmount),
      pendingPayment: allocation.pendingPayment
        ? {
            ...allocation.pendingPayment,
            amountDue: Number(allocation.pendingPayment.amountDue),
            amountReceived: Number(allocation.pendingPayment.amountReceived),
            finalSettledAmount:
              allocation.pendingPayment.finalSettledAmount === null
                ? null
                : Number(allocation.pendingPayment.finalSettledAmount),
            discountAmount: Number(allocation.pendingPayment.discountAmount || 0),
            discountPercent: Number(allocation.pendingPayment.discountPercent || 0),
            balanceAmount: Number(allocation.pendingPayment.balanceAmount),
          }
        : null,
    })),
  };
}

const listPaymentReceipts = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const selectedFinancialYearStart = await getSelectedFinancialYearStartForUser(userId);
  const pagination = parsePagination(req.query);
  const { sortBy, sortOrder } = parseSort(req.query, RECEIPT_SORT_FIELDS, "date", "desc");
  const search = normalizeSearch(req.query.search);
  const paymentModeFilter = req.query.paymentMode ? String(req.query.paymentMode).toUpperCase() : null;
  if (paymentModeFilter && !Object.values(PAYMENT_MODES).includes(paymentModeFilter)) {
    throw new AppError("paymentMode must be one of: CASH, CHEQUE, ONLINE, UPI", 400);
  }
  const dateFrom = req.query.dateFrom ? new Date(String(req.query.dateFrom)) : null;
  const dateTo = req.query.dateTo ? new Date(String(req.query.dateTo)) : null;
  const receivedFrom = req.query.receivedFrom ? new Date(String(req.query.receivedFrom)) : null;
  const receivedTo = req.query.receivedTo ? new Date(String(req.query.receivedTo)) : null;
  if (dateFrom && Number.isNaN(dateFrom.getTime())) {
    throw new AppError("invalid dateFrom date", 400);
  }
  if (dateTo && Number.isNaN(dateTo.getTime())) {
    throw new AppError("invalid dateTo date", 400);
  }
  if (receivedFrom && Number.isNaN(receivedFrom.getTime())) {
    throw new AppError("invalid receivedFrom date", 400);
  }
  if (receivedTo && Number.isNaN(receivedTo.getTime())) {
    throw new AppError("invalid receivedTo date", 400);
  }
  const normalizedPaymentModeSearch = search ? String(search).toUpperCase() : null;
  const hasPaymentModeSearch =
    normalizedPaymentModeSearch &&
    Object.values(PAYMENT_MODES).includes(normalizedPaymentModeSearch);

  const where = {
    userId,
    fyStartYear: selectedFinancialYearStart,
    ...(paymentModeFilter ? { paymentMode: paymentModeFilter } : {}),
    ...(dateFrom || dateTo
      ? {
          date: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          },
        }
      : {}),
    ...(receivedFrom || receivedTo
      ? {
          paymentReceivedDate: {
            ...(receivedFrom ? { gte: receivedFrom } : {}),
            ...(receivedTo ? { lte: receivedTo } : {}),
          },
        }
      : {}),
    ...(search
      ? {
          OR: [
            { accountName: { contains: search, mode: "insensitive" } },
            Number.isFinite(Number.parseInt(search, 10))
              ? { serialNo: Number.parseInt(search, 10) }
              : undefined,
            {
              paymentAllocations: {
                some: {
                  pendingPayment: {
                    order: {
                      customer: {
                        OR: [
                          { name: { contains: search, mode: "insensitive" } },
                          { firmName: { contains: search, mode: "insensitive" } },
                        ],
                      },
                    },
                  },
                },
              },
            },
            Number.isFinite(Number.parseInt(search, 10))
              ? {
                  paymentAllocations: {
                    some: {
                      pendingPayment: {
                        OR: [
                          { serialNo: Number.parseInt(search, 10) },
                          { order: { orderNo: Number.parseInt(search, 10) } },
                        ],
                      },
                    },
                  },
                }
              : undefined,
            hasPaymentModeSearch ? { paymentMode: { equals: normalizedPaymentModeSearch } } : undefined,
          ].filter(Boolean),
        }
      : {}),
  };

  const receipts = await prisma.paymentReceipt.findMany({
    where,
    orderBy: { [sortBy]: sortOrder },
    skip: pagination.skip,
    take: pagination.take,
    include: {
      paymentAllocations: {
        include: {
          pendingPayment: {
            select: {
              id: true,
              serialNo: true,
              amountDue: true,
              amountReceived: true,
              finalSettledAmount: true,
              discountAmount: true,
              discountPercent: true,
              balanceAmount: true,
              status: true,
              orderId: true,
              order: { select: { orderNo: true } },
            },
          },
        },
      },
    },
  });

  const normalized = receipts.map(normalizeReceipt);

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
    include: {
      paymentAllocations: {
        include: {
          pendingPayment: {
            select: {
              id: true,
              serialNo: true,
              amountDue: true,
              amountReceived: true,
              finalSettledAmount: true,
              discountAmount: true,
              discountPercent: true,
              balanceAmount: true,
              status: true,
              orderId: true,
              order: { select: { orderNo: true } },
            },
          },
        },
      },
    },
  });

  if (!receipt) {
    throw new AppError("payment receipt not found", 404);
  }

  return res.json(normalizeReceipt(receipt));
});

const deletePaymentReceipt = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  const receipt = await prisma.paymentReceipt.findFirst({
    where: { id, userId },
    select: {
      id: true,
      paymentAllocations: {
        select: { pendingPaymentId: true },
      },
    },
  });

  if (!receipt) {
    throw new AppError("payment receipt not found", 404);
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentReceipt.delete({
      where: { id: receipt.id },
    });

    const pendingPaymentIds = [...new Set(receipt.paymentAllocations.map((item) => item.pendingPaymentId))];
    for (const pendingPaymentId of pendingPaymentIds) {
      await syncPendingPaymentAmounts(tx, pendingPaymentId);
    }
  });

  return res.status(204).send();
});

module.exports = {
  listPaymentReceipts,
  getPaymentReceiptById,
  deletePaymentReceipt,
};
