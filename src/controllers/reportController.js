const prisma = require("../config/prisma");
const asyncHandler = require("../utils/asyncHandler");
const { sendWorkbook } = require("../utils/reportExcel");
const {
  getFinancialYearStartYear,
  getFinancialYearLabel,
} = require("../utils/financialYear");
const AppError = require("../utils/appError");

const ORDER_STATUS = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
};

const REPORT_STATUS = {
  ALL: "ALL",
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
};

const REPORT_USER_TYPE = {
  CUSTOMER: "CUSTOMER",
  MANUFACTURER: "MANUFACTURER",
};

const REPORT_GROUP_BY = {
  CUSTOMER: "CUSTOMER",
  MANUFACTURER: "MANUFACTURER",
  QUALITY: "QUALITY",
};

const DEFAULT_REPORT_COMPANY = {
  address:
    "D-601 SONAL RESIDENCY, OPP RESHMA ROW HOUSE, PUNA PATIYA, SURAT-395010",
  phone: "9328447108,",
};

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

function buildDateFilter(query) {
  const { from, to } = query;
  if (!from && !to) return undefined;

  const filter = {};
  if (from) filter.gte = new Date(from);
  if (to) filter.lte = new Date(to);
  return filter;
}

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

function normalizeStatusFilter(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (!normalized || normalized === REPORT_STATUS.ALL) {
    return null;
  }
  if (!Object.values(ORDER_STATUS).includes(normalized)) {
    throw new AppError("status must be one of: all, pending, completed", 400);
  }
  if (normalized === ORDER_STATUS.CANCELLED) {
    throw new AppError("status must be one of: all, pending, completed", 400);
  }
  return normalized;
}

function normalizeUserTypeFilter(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (!normalized) {
    return REPORT_USER_TYPE.CUSTOMER;
  }
  if (!Object.values(REPORT_USER_TYPE).includes(normalized)) {
    throw new AppError("userType must be one of: customer, manufacturer", 400);
  }
  return normalized;
}

function normalizeGroupByFilter(value, reportType) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (!normalized) {
    return REPORT_GROUP_BY.QUALITY;
  }

  if (!Object.values(REPORT_GROUP_BY).includes(normalized)) {
    throw new AppError(
      "groupBy must be one of: customer, manufacturer, quality",
      400
    );
  }

  return normalized;
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

function formatDisplayDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function formatFinancialYearRange(startYear) {
  const year = Number(startYear);
  if (!Number.isFinite(year)) {
    return "";
  }
  return `(F.Y. - ${getFinancialYearLabel(year)})`;
}

function formatReportLine(label, value) {
  return `${String(label).padEnd(10, " ")}: ${value || "-"}`;
}

function getReportCompanyInfo() {
  return DEFAULT_REPORT_COMPANY;
}

function computeLotValue(order) {
  const quantity = safeNumber(order.quantity);
  const unit = String(order.quantityUnit || "").toUpperCase();
  const lotMeters = safeNumber(order.lotMeters);

  if (unit === "LOT") {
    return round2(quantity);
  }
  if (unit === "TAKKA") {
    return round2(quantity / 12);
  }
  if (unit === "METER" && lotMeters > 0) {
    return round2(quantity / lotMeters);
  }
  return "";
}

function computeMeterValue(order) {
  const quantity = safeNumber(order.quantity);
  const unit = String(order.quantityUnit || "").toUpperCase();
  const lotMeters = safeNumber(order.lotMeters);

  if (unit === "METER") {
    return round2(quantity);
  }
  if (unit === "LOT" && lotMeters > 0) {
    return round2(quantity * lotMeters);
  }
  if (unit === "TAKKA" && lotMeters > 0) {
    return round2(quantity * (lotMeters / 12));
  }
  return "";
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

async function getOrderFilters(query, userId) {
  const selectedFinancialYearStart =
    await getSelectedFinancialYearStartForUser(userId);
  const where = { userId, fyStartYear: selectedFinancialYearStart };
  const orderDate = buildDateFilter(query);
  if (orderDate) where.orderDate = orderDate;
  if (query.customerId) where.customerId = query.customerId;
  if (query.manufacturerId) where.manufacturerId = query.manufacturerId;
  if (query.qualityId) where.qualityId = query.qualityId;
  return where;
}

function getOrderInclude() {
  return {
    user: { select: { id: true, name: true, email: true } },
    customer: true,
    manufacturer: true,
    quality: true,
  };
}

async function fetchOrders(where) {
  return prisma.order.findMany({
    where,
    orderBy: [{ orderDate: "desc" }, { orderNo: "desc" }],
    include: getOrderInclude(),
  });
}

function buildReportColumns(reportType) {
  const partyColumns =
    reportType === "manufacturer"
      ? [
          { header: "Customer Firm", key: "partyFirmName", width: 24 },
          { header: "Customer Name", key: "partyName", width: 24 },
        ]
      : [
          { header: "Manufacture Firm", key: "partyFirmName", width: 24 },
          { header: "Manufacturer Name", key: "partyName", width: 24 },
        ];

  return [
    { header: "Amount", key: "amount", width: 14 },
    { header: "LOT", key: "lot", width: 12 },
    { header: "Quality", key: "quality", width: 24 },
    { header: "Meter", key: "meter", width: 14 },
    { header: "Rate", key: "rate", width: 12 },
    { header: "orderId", key: "orderId", width: 12 },
    { header: "Date", key: "date", width: 14 },
    ...partyColumns,
  ];
}

function orderToReportRow(order, reportType) {
  const party =
    reportType === "manufacturer" ? order.customer : order.manufacturer;

  return {
    amount: roundCurrency(order.commissionAmount ?? 0),
    lot: computeLotValue(order),
    quality: order.quality?.name || "",
    meter: computeMeterValue(order),
    rate: round2(order.rate),
    orderId: order.orderNo,
    date: formatCellDate(order.orderDate),
    partyFirmName: party?.firmName || "",
    partyName: party?.name || "",
  };
}

function getGroupValue(order, groupBy) {
  if (groupBy === REPORT_GROUP_BY.QUALITY) {
    return order.quality;
  }
  if (groupBy === REPORT_GROUP_BY.MANUFACTURER) {
    return order.manufacturer;
  }
  return order.customer;
}

function getGroupDisplayName(groupValue, groupBy) {
  if (groupBy === REPORT_GROUP_BY.QUALITY) {
    return String(groupValue?.name || "").trim() || "UNKNOWN";
  }

  const label =
    groupBy === REPORT_GROUP_BY.MANUFACTURER ? "Manufacturer" : "Customer";
  const firmName = String(groupValue?.firmName || "").trim();
  const name = String(groupValue?.name || "").trim();

  if (firmName && name) {
    return `${firmName} (${name})`;
  }
  if (firmName) {
    return firmName;
  }
  if (name) {
    return name;
  }
  return `${label}: UNKNOWN`;
}

function sortReportOrders(orders) {
  return [...orders].sort((a, b) => {
    const dateA = new Date(a.orderDate || 0).getTime();
    const dateB = new Date(b.orderDate || 0).getTime();
    if (dateA !== dateB) return dateA - dateB;
    return Number(a.orderNo || 0) - Number(b.orderNo || 0);
  });
}

function buildReportSections(orders, reportType, groupBy) {
  const groupMap = new Map();

  orders.forEach((order) => {
    const groupValue = getGroupValue(order, groupBy);
    const partyKey =
      groupValue?.id ||
      `${String(groupValue?.firmName || groupValue?.name || "")
        .trim()
        .toLowerCase()}::${String(groupValue?.name || "")
        .trim()
        .toLowerCase()}` ||
      "unknown";

    if (!groupMap.has(partyKey)) {
      groupMap.set(partyKey, {
        groupValue,
        orders: [],
      });
    }

    groupMap.get(partyKey).orders.push(order);
  });

  return [...groupMap.values()]
    .sort((left, right) =>
      getGroupDisplayName(left.groupValue, groupBy).localeCompare(
        getGroupDisplayName(right.groupValue, groupBy),
        undefined,
        { sensitivity: "base" }
      )
    )
    .map((group) => {
      const sortedGroupOrders = sortReportOrders(group.orders);
      return {
        showHeader: false,
        rows: sortedGroupOrders.map((order) => orderToReportRow(order, reportType)),
        footerLines: [
          {
            value: "=========================",
            alignment: "center",
            fontSize: 11,
            bold: true,
            height: 18,
          },
        ],
      };
    });
}

async function exportReportByType(req, res, reportType) {
  const status = normalizeStatusFilter(req.query.status);
  const groupBy = normalizeGroupByFilter(req.query.groupBy, reportType);
  const userType =
      reportType === "manufacturer"
      ? REPORT_USER_TYPE.MANUFACTURER
      : REPORT_USER_TYPE.CUSTOMER;
  const where = await getOrderFilters(req.query, req.user.userId);
  if (status) {
    where.status = status;
  }

  const orders = await fetchOrders(where);

  const fileName =
    reportType === "manufacturer"
      ? "manufacturer-report.xlsx"
      : "customer-report.xlsx";
  const sheetColumns = buildReportColumns(reportType);
  const headerLines = [
    {
      value: "Moolchand H Vadera",
      alignment: "center",
      fontSize: 14,
      bold: true,
      height: 24,
    },
    {
      value: "Grey Broker & Commission Agent",
      alignment: "center",
      fontSize: 13,
      bold: true,
      height: 24,
    },
    {
      value: "(M) 9374565779, 7016605692",
      alignment: "center",
      fontSize: 13,
      bold: true,
      height: 24,
    },
  ];

  await sendWorkbook(res, fileName, [
    {
      headerLines,
      columns: sheetColumns,
      sections: buildReportSections(orders, reportType, groupBy),
    },
  ]);
}

const exportOrderReport = asyncHandler(async (req, res) => {
  const userType = normalizeUserTypeFilter(req.query.userType);
  const reportType =
    userType === REPORT_USER_TYPE.MANUFACTURER ? "manufacturer" : "customer";
  const fileName =
    reportType === "manufacturer"
      ? "manufacturer-report.xlsx"
      : "customer-report.xlsx";
  await exportReportByType(req, res, reportType);
});

const exportCustomerReport = asyncHandler(async (req, res) => {
  await exportReportByType(req, res, "customer");
});

const exportManufacturerReport = asyncHandler(async (req, res) => {
  await exportReportByType(req, res, "manufacturer");
});

module.exports = {
  exportOrderReport,
  exportCustomerReport,
  exportManufacturerReport,
};
