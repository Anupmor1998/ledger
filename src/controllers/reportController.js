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

function withStatus(where, status) {
  if (!status) return where;
  return { ...where, status };
}

function getPartyLabel(reportType) {
  return reportType === "manufacturer" ? "Customer" : "Manufacturer";
}

function getPartyDisplayInfo(order, reportType) {
  const party =
    reportType === "manufacturer" ? order.customer : order.manufacturer;
  const firmName = String(party?.firmName || party?.name || "").trim();
  const secondaryName = String(
    party?.firmName && party?.name ? party.name : "",
  ).trim();
  return {
    id: party?.id || firmName || `party-${order.id}`,
    firmName: party?.firmName || party?.name || "",
    name: party?.name || "",
    gstNo: party?.gstNo || "",
    address: party?.address || "",
    phone: party?.phone || "",
    displayName: secondaryName
      ? `${firmName} (${secondaryName})`
      : firmName || "-",
  };
}

function buildPartySectionHeaderLines(reportType, partyInfo) {
  return [
    formatReportLine("Firm Name", partyInfo.displayName),
    formatReportLine("GSTIN", partyInfo.gstNo || "-"),
    formatReportLine("Address", partyInfo.address || "-"),
    formatReportLine("Phone", partyInfo.phone || "-"),
  ];
}

function buildReportSections(orders, reportType) {
  const groups = new Map();

  orders.forEach((order) => {
    const partyInfo = getPartyDisplayInfo(order, reportType);
    if (!groups.has(partyInfo.id)) {
      groups.set(partyInfo.id, {
        partyInfo,
        rows: [],
      });
    }
    groups.get(partyInfo.id).rows.push(orderToReportRow(order, reportType));
  });

  return Array.from(groups.values()).map(({ partyInfo, rows }) => ({
    headerLines: buildPartySectionHeaderLines(reportType, partyInfo),
    columns: buildReportColumns(reportType),
    rows,
  }));
}

async function exportReportByType(req, res, reportType) {
  const status = normalizeStatusFilter(req.query.status);
  const userType =
    reportType === "manufacturer"
      ? REPORT_USER_TYPE.MANUFACTURER
      : REPORT_USER_TYPE.CUSTOMER;
  const where = await getOrderFilters(req.query, req.user.userId);
  if (status) {
    where.status = status;
  }

  const orders = await fetchOrders(where);
  const companyInfo = getReportCompanyInfo();
  const currentFinancialYearStart = getFinancialYearStartYear();
  const selectedFinancialYearStart = await getSelectedFinancialYearStartForUser(
    req.user.userId,
  );
  const fromDate = req.query.from
    ? formatDisplayDate(req.query.from)
    : `01/04/${selectedFinancialYearStart}`;
  const toDate = req.query.to
    ? formatDisplayDate(req.query.to)
    : `31/03/${selectedFinancialYearStart + 1}`;
  const sortedOrders = [...orders].sort((a, b) => {
    const aValue =
      reportType === "manufacturer"
        ? a.customer?.firmName || a.customer?.name || ""
        : a.manufacturer?.firmName || a.manufacturer?.name || "";
    const bValue =
      reportType === "manufacturer"
        ? b.customer?.firmName || b.customer?.name || ""
        : b.manufacturer?.firmName || b.manufacturer?.name || "";
    const nameSort = String(aValue).localeCompare(String(bValue));
    if (nameSort !== 0) return nameSort;
    return Number(b.orderNo || 0) - Number(a.orderNo || 0);
  });

  const fileName =
    reportType === "manufacturer"
      ? "manufacturer-report.xlsx"
      : "customer-report.xlsx";
  const sheetColumns = buildReportColumns(reportType);
  const headerLines = [
    `Firm Name : MAHAVEER FAB (GSTIN : 24ABNPJ1957H1ZJ) ${formatFinancialYearRange(currentFinancialYearStart)}`,
    formatReportLine("Address", companyInfo.address),
    formatReportLine("Phone", companyInfo.phone),
    formatReportLine(
      "DATE",
      `(${fromDate.toUpperCase()} TO ${toDate.toUpperCase()})`,
    ),
    formatReportLine("REPORT", "LEDGER REPORT"),
  ];

  await sendWorkbook(res, fileName, [
    {
      headerLines,
      columns: sheetColumns,
      sections: buildReportSections(sortedOrders, reportType),
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
