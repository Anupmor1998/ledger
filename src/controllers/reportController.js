const prisma = require("../config/prisma");
const asyncHandler = require("../utils/asyncHandler");
const { sendWorkbook } = require("../utils/reportExcel");
const { sendPdfReport } = require("../utils/reportPdf");
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
  DATE: "DATE",
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
    return REPORT_GROUP_BY.DATE;
  }

  if (!Object.values(REPORT_GROUP_BY).includes(normalized)) {
    throw new AppError(
      "groupBy must be one of: date, customer, manufacturer, quality",
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

function getPartyDisplayName(party) {
  return String(party?.firmName || party?.name || "").trim();
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
  return round2(safeNumber(order.processedMeter));
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

async function getSelectedReportParty(query, reportType, userId) {
  const isManufacturerReport = reportType === "manufacturer";
  const partyId = isManufacturerReport ? query.manufacturerId : query.customerId;
  if (!partyId) {
    return null;
  }

  const where = { id: partyId, userId };
  const select = {
    firmName: true,
    name: true,
    address: true,
    phone: true,
  };

  return isManufacturerReport
    ? prisma.manufacturer.findFirst({ where, select })
    : prisma.customer.findFirst({ where, select });
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
    meter: computeMeterValue(order).toFixed(2),
    rate: round2(order.rate).toFixed(2),
    orderId: order.orderNo,
    date: formatCellDate(order.orderDate),
    partyFirmName: party?.firmName || "",
    partyName: party?.name || "",
  };
}

function computeReportTotals(orders) {
  return orders.reduce(
    (totals, order) => {
      totals.amount += roundCurrency(order.commissionAmount ?? 0);
      totals.lot += Number(computeLotValue(order) || 0);
      return totals;
    },
    {
      amount: 0,
      lot: 0,
    }
  );
}

function getGroupValue(order, groupBy) {
  if (groupBy === REPORT_GROUP_BY.DATE) {
    return null;
  }
  if (groupBy === REPORT_GROUP_BY.QUALITY) {
    return order.quality;
  }
  if (groupBy === REPORT_GROUP_BY.MANUFACTURER) {
    return order.manufacturer;
  }
  return order.customer;
}

function getGroupDisplayName(groupValue, groupBy) {
  if (groupBy === REPORT_GROUP_BY.DATE) {
    return "Date";
  }
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

function isSpecificScope(query, reportType) {
  if (reportType === "manufacturer") {
    return Boolean(String(query.manufacturerId || "").trim());
  }
  return Boolean(String(query.customerId || "").trim());
}

function getScopeParty(order, reportType) {
  return reportType === "manufacturer" ? order.manufacturer : order.customer;
}

function getScopePartyLabel(reportType) {
  return reportType === "manufacturer" ? "Manufacturer" : "Customer";
}

function getScopeHeaderLines(party, reportType) {
  const partyLabel = getScopePartyLabel(reportType);
  const name = String(party?.firmName || party?.name || "-").trim() || "-";
  return [
    {
      value: `${partyLabel} Name : ${name}`,
      alignment: "left",
      fontSize: 11,
      bold: true,
      height: 20,
    },
    {
      value: `Address   : ${String(party?.address || "-").trim() || "-"}`,
      alignment: "left",
      fontSize: 11,
      bold: true,
      height: 20,
    },
    {
      value: `Mobile    : ${String(party?.phone || "-").trim() || "-"}`,
      alignment: "left",
      fontSize: 11,
      bold: true,
      height: 20,
    },
  ];
}

function getSelectedPartyHeaderLines(party, reportType) {
  const partyLabel = getScopePartyLabel(reportType);
  const name = String(party?.firmName || party?.name || "-").trim() || "-";
  return [
    {
      value: `${partyLabel} Name : ${name}`,
      alignment: "left",
      fontSize: 14,
      bold: true,
      height: 24,
    },
    {
      value: `Address   : ${String(party?.address || "-").trim() || "-"}`,
      alignment: "left",
      fontSize: 14,
      bold: true,
      height: 24,
    },
    {
      value: `Phone     : ${String(party?.phone || "-").trim() || "-"}`,
      alignment: "left",
      fontSize: 14,
      bold: true,
      height: 24,
    },
  ];
}

function buildFinalTotalRow(finalTotals) {
  return {
    __highlight: true,
    amount: finalTotals.amount,
    lot: finalTotals.lot,
    quality: "",
    meter: "",
    rate: "",
    orderId: "",
    date: "",
    partyFirmName: "",
    partyName: "",
  };
}

function getScopeSortLabel(scopeParty, reportType) {
  const label =
    reportType === "manufacturer" ? "Manufacturer" : "Customer";
  return String(
    scopeParty?.firmName || scopeParty?.name || `${label}: UNKNOWN`
  ).trim();
}

function buildReportSections(orders, reportType, groupBy, query) {
  const groupMap = new Map();
  const specificScope = isSpecificScope(query, reportType);
  const finalTotals = computeReportTotals(orders);

  if (specificScope) {
    const sections = [
      {
        showHeader: false,
        rows: sortReportOrders(orders).map((order) => orderToReportRow(order, reportType)),
      },
    ];
    sections.push({
      showHeader: false,
      rows: [buildFinalTotalRow(finalTotals)],
    });
    return sections;
  }

  orders.forEach((order) => {
    const scopeParty = getScopeParty(order, reportType);
    const scopeKey =
      scopeParty?.id ||
      `${String(scopeParty?.firmName || scopeParty?.name || "")
        .trim()
        .toLowerCase()}::${String(scopeParty?.phone || "")
        .trim()
        .toLowerCase()}` ||
      "unknown";

    if (!groupMap.has(scopeKey)) {
      groupMap.set(scopeKey, {
        scopeParty,
        orders: [],
      });
    }

    groupMap.get(scopeKey).orders.push(order);
  });

  const sortedScopes = [...groupMap.values()].sort((left, right) =>
    getScopeSortLabel(left.scopeParty, reportType)
      .localeCompare(
        getScopeSortLabel(right.scopeParty, reportType),
        undefined,
        { sensitivity: "base" }
      )
  );

  const sections = [];

  sortedScopes.forEach((scopeGroup) => {
    const sortedScopeOrders = sortReportOrders(scopeGroup.orders);

    if (groupBy === REPORT_GROUP_BY.DATE) {
      sections.push({
        headerLines: getScopeHeaderLines(scopeGroup.scopeParty, reportType),
        rows: sortedScopeOrders.map((order) => orderToReportRow(order, reportType)),
        footerLines: [
          {
            value: "=========================",
            alignment: "center",
            fontSize: 11,
            bold: true,
            height: 18,
          },
        ],
      });
      return;
    }

    const innerMap = new Map();
    sortedScopeOrders.forEach((order) => {
      const groupValue = getGroupValue(order, groupBy);
      const innerKey =
        groupValue?.id ||
        `${String(groupValue?.firmName || groupValue?.name || "")
          .trim()
          .toLowerCase()}::${String(groupValue?.name || "")
          .trim()
          .toLowerCase()}` ||
        "unknown";

      if (!innerMap.has(innerKey)) {
        innerMap.set(innerKey, {
          groupValue,
          orders: [],
        });
      }

      innerMap.get(innerKey).orders.push(order);
    });

    const sortedInnerGroups = [...innerMap.values()].sort((left, right) =>
      getGroupDisplayName(left.groupValue, groupBy).localeCompare(
        getGroupDisplayName(right.groupValue, groupBy),
        undefined,
        { sensitivity: "base" }
      )
    );

    sortedInnerGroups.forEach((innerGroup, index) => {
      sections.push({
        headerLines: index === 0 ? getScopeHeaderLines(scopeGroup.scopeParty, reportType) : [],
        rows: sortReportOrders(innerGroup.orders).map((order) => orderToReportRow(order, reportType)),
        footerLines: [
          {
            value: "=========================",
            alignment: "center",
            fontSize: 11,
            bold: true,
            height: 18,
          },
        ],
      });
    });
  });

  sections.push({
    showHeader: false,
    rows: [buildFinalTotalRow(finalTotals)],
  });

  return sections;
}

async function exportReportByType(req, res, reportType, format = "xlsx") {
  const normalizedFormat = String(format || "xlsx").toLowerCase();
  const status = normalizeStatusFilter(req.query.status);
  const groupBy = normalizeGroupByFilter(req.query.groupBy, reportType);
  const where = await getOrderFilters(req.query, req.user.userId);
  if (status) {
    where.status = status;
  }

  const orders = await fetchOrders(where);
  const selectedParty = await getSelectedReportParty(
    req.query,
    reportType,
    req.user.userId
  );

  const baseFileName = reportType === "manufacturer" ? "manufacturer-report" : "customer-report";
  const fileName = `${baseFileName}.${normalizedFormat === "pdf" ? "pdf" : "xlsx"}`;
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
    ...(selectedParty ? getSelectedPartyHeaderLines(selectedParty, reportType) : []),
  ].filter(Boolean);

  const sheetConfig = {
    headerLines,
    columns: sheetColumns,
    sections: buildReportSections(orders, reportType, groupBy, req.query),
  };

  if (normalizedFormat === "pdf") {
    await sendPdfReport(res, fileName, [sheetConfig]);
    return;
  }

  await sendWorkbook(res, fileName, [sheetConfig]);
}

const exportOrderReport = asyncHandler(async (req, res) => {
  const userType = normalizeUserTypeFilter(req.query.userType);
  const reportType =
    userType === REPORT_USER_TYPE.MANUFACTURER ? "manufacturer" : "customer";
  await exportReportByType(req, res, reportType, "xlsx");
});

const exportCustomerReport = asyncHandler(async (req, res) => {
  await exportReportByType(req, res, "customer", "xlsx");
});

const exportManufacturerReport = asyncHandler(async (req, res) => {
  await exportReportByType(req, res, "manufacturer", "xlsx");
});

const exportOrderReportPdf = asyncHandler(async (req, res) => {
  const userType = normalizeUserTypeFilter(req.query.userType);
  const reportType =
    userType === REPORT_USER_TYPE.MANUFACTURER ? "manufacturer" : "customer";
  await exportReportByType(req, res, reportType, "pdf");
});

const exportCustomerReportPdf = asyncHandler(async (req, res) => {
  await exportReportByType(req, res, "customer", "pdf");
});

const exportManufacturerReportPdf = asyncHandler(async (req, res) => {
  await exportReportByType(req, res, "manufacturer", "pdf");
});

module.exports = {
  exportOrderReport,
  exportCustomerReport,
  exportManufacturerReport,
  exportOrderReportPdf,
  exportCustomerReportPdf,
  exportManufacturerReportPdf,
};
