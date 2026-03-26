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
  };
}

const listPaymentReceipts = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const selectedFinancialYearStart = await getSelectedFinancialYearStartForUser(userId);
  const pagination = parsePagination(req.query);
  const { sortBy, sortOrder } = parseSort(req.query, RECEIPT_SORT_FIELDS, "date", "desc");
  const search = normalizeSearch(req.query.search);
  const normalizedPaymentModeSearch = search ? String(search).toUpperCase() : null;
  const hasPaymentModeSearch =
    normalizedPaymentModeSearch &&
    Object.values(PAYMENT_MODES).includes(normalizedPaymentModeSearch);

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
            { pendingPayment: { accountName: { contains: search, mode: "insensitive" } } },
            hasPaymentModeSearch
              ? { paymentMode: { equals: normalizedPaymentModeSearch } }
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
    select: { id: true, pendingPaymentId: true },
  });

  if (!receipt) {
    throw new AppError("payment receipt not found", 404);
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentReceipt.delete({
      where: { id: receipt.id },
    });
    if (receipt.pendingPaymentId) {
      await syncPendingPaymentAmounts(tx, receipt.pendingPaymentId);
    }
  });

  return res.status(204).send();
});

module.exports = {
  listPaymentReceipts,
  getPaymentReceiptById,
  deletePaymentReceipt,
};
