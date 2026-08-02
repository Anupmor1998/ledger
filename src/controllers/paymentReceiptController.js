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

function buildPaymentReceiptSearchWhere(searchField, search) {
  const normalizedSearch = normalizeSearch(search);
  if (!normalizedSearch) {
    return null;
  }

  const selectedField = String(searchField || "").trim();
  const numericValue = Number(normalizedSearch);

  switch (selectedField) {
    case "accountName":
      return { accountName: { contains: normalizedSearch, mode: "insensitive" } };
    case "serialNo":
      return Number.isFinite(numericValue)
        ? { serialNo: numericValue }
        : { id: "__no_payment_receipt_search_match__" };
    case "customerName":
      return {
        paymentAllocations: {
          some: {
            pendingPayment: {
              order: {
                customer: {
                  name: { contains: normalizedSearch, mode: "insensitive" },
                },
              },
            },
          },
        },
      };
    case "customerFirmName":
      return {
        paymentAllocations: {
          some: {
            pendingPayment: {
              order: {
                customer: {
                  firmName: { contains: normalizedSearch, mode: "insensitive" },
                },
              },
            },
          },
        },
      };
    case "orderNo":
      return Number.isFinite(numericValue)
        ? {
            paymentAllocations: {
              some: {
                pendingPayment: {
                  order: { orderNo: numericValue },
                },
              },
            },
          }
        : { id: "__no_payment_receipt_search_match__" };
    case "paymentMode": {
      const mode = normalizedSearch.toUpperCase();
      return Object.values(PAYMENT_MODES).includes(mode)
        ? { paymentMode: mode }
        : { id: "__no_payment_receipt_search_match__" };
    }
    case "amount":
      return Number.isFinite(numericValue)
        ? { amount: numericValue }
        : { id: "__no_payment_receipt_search_match__" };
    case "date":
    case "paymentReceivedDate": {
      const date = new Date(normalizedSearch);
      if (Number.isNaN(date.getTime())) {
        return { id: "__no_payment_receipt_search_match__" };
      }
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      return {
        [selectedField]: {
          gte: start,
          lte: end,
        },
      };
    }
    default: {
      const searchAsNumber = Number.parseInt(normalizedSearch, 10);
      const hasNumericSearch = Number.isFinite(searchAsNumber);
      const normalizedPaymentModeSearch = normalizedSearch.toUpperCase();
      const hasPaymentModeSearch = Object.values(PAYMENT_MODES).includes(normalizedPaymentModeSearch);
      return {
        OR: [
          { accountName: { contains: normalizedSearch, mode: "insensitive" } },
          hasNumericSearch ? { serialNo: searchAsNumber } : undefined,
          {
            paymentAllocations: {
              some: {
                pendingPayment: {
                  order: {
                    customer: {
                      OR: [
                        { name: { contains: normalizedSearch, mode: "insensitive" } },
                        { firmName: { contains: normalizedSearch, mode: "insensitive" } },
                      ],
                    },
                  },
                },
              },
            },
          },
          hasNumericSearch
            ? {
                paymentAllocations: {
                  some: {
                    pendingPayment: {
                      OR: [
                        { serialNo: searchAsNumber },
                        { order: { orderNo: searchAsNumber } },
                      ],
                    },
                  },
                },
              }
            : undefined,
          hasPaymentModeSearch ? { paymentMode: { equals: normalizedPaymentModeSearch } } : undefined,
        ].filter(Boolean),
      };
    }
  }
}

const listPaymentReceipts = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const selectedFinancialYearStart = await getSelectedFinancialYearStartForUser(userId);
  const pagination = parsePagination(req.query);
  const { sortBy, sortOrder } = parseSort(req.query, RECEIPT_SORT_FIELDS, "date", "desc");
  const search = normalizeSearch(req.query.search);
  const searchField = String(req.query.searchField || "").trim();
  const normalizedSearch = normalizeSearch(search);
  const useInMemoryNumericSubstringSearch = Boolean(normalizedSearch) &&
    ["serialNo", "orderNo", "amount"].includes(searchField);
  const searchWhere = buildPaymentReceiptSearchWhere(req.query.searchField, search);
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
    ...(!useInMemoryNumericSubstringSearch ? searchWhere || {} : {}),
  };

  const queryOptions = {
    where,
    orderBy: { [sortBy]: sortOrder },
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
  };

  const receipts = useInMemoryNumericSubstringSearch
    ? await prisma.paymentReceipt.findMany(queryOptions)
    : await prisma.paymentReceipt.findMany({
        ...queryOptions,
        skip: pagination.skip,
        take: pagination.take,
      });

  const filteredReceipts = useInMemoryNumericSubstringSearch
    ? receipts.filter((receipt) => {
        let fieldValue = null;
        switch (searchField) {
          case "serialNo":
            fieldValue = receipt.serialNo;
            break;
          case "orderNo":
            fieldValue = receipt.paymentAllocations?.some((allocation) =>
              String(allocation?.pendingPayment?.order?.orderNo || "").includes(normalizedSearch)
            );
            break;
          case "amount":
            fieldValue = receipt.amount;
            break;
          default:
            fieldValue = null;
        }
        if (searchField === "orderNo") {
          return Boolean(fieldValue);
        }
        return fieldValue !== null && fieldValue !== undefined
          ? String(fieldValue).includes(normalizedSearch)
          : false;
      })
    : receipts;

  const normalized = filteredReceipts.map(normalizeReceipt);

  if (!pagination.enabled) {
    return res.json(normalized);
  }

  if (useInMemoryNumericSubstringSearch) {
    const paginated = normalized.slice(pagination.skip, pagination.skip + pagination.take);
    return res.json(
      buildPaginatedResponse(paginated, normalized.length, pagination.page, pagination.limit)
    );
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
