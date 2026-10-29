const crypto = require("crypto");
const prisma = require("../config/prisma");
const asyncHandler = require("../utils/asyncHandler");
const { sendWorkbook } = require("../utils/reportExcel");
const { sendPdfReport } = require("../utils/reportPdf");
const {
  getFinancialYearStartYear,
  getFinancialYearLabel,
} = require("../utils/financialYear");
const {
  createReportShareToken,
  verifyReportShareToken,
} = require("../utils/jwt");
const AppError = require("../utils/appError");

const ORDER_STATUS = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  TRANSFERRED: "TRANSFERRED",
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

const REPORT_PAYMENT_STATUS = {
  UNPAID: "UNPAID",
  PAID: "PAID",
  ALL: "ALL",
};

function normalizePaymentStatusFilter(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (!normalized) {
    return REPORT_PAYMENT_STATUS.UNPAID;
  }
  if (!Object.values(REPORT_PAYMENT_STATUS).includes(normalized)) {
    throw new AppError(
      "paymentStatus must be one of: unpaid, paid, all",
      400,
    );
  }
  return normalized;
}

function resolveOrderPaymentStatus(order) {
  const ppStatus = String(order?.pendingPayment?.status || "").toUpperCase();
  if (ppStatus === "PAID" || ppStatus === "SETTLED") {
    return "PAID";
  }
  if (ppStatus === "TRANSFERRED") {
    return "TRANSFERRED";
  }

  const poas = Array.isArray(order?.paymentOrderAllocations)
    ? order.paymentOrderAllocations
    : [];
  if (poas.length > 0) {
    const isSettled = poas.some((alloc) => alloc.isSettled);
    const totalAllocated = round2(
      poas.reduce((sum, alloc) => sum + Number(alloc.allocatedAmount || 0), 0),
    );
    const commission = roundCurrency(order.commissionAmount ?? 0);
    if (isSettled || (commission > 0 && totalAllocated >= commission)) {
      return "PAID";
    }
    if (totalAllocated > 0) {
      return "PARTIAL";
    }
  }

  if (
    ppStatus === "PARTIALLY_PAID" ||
    ppStatus === "PARTIAL" ||
    Number(order?.pendingPayment?.amountReceived || 0) > 0
  ) {
    return "PARTIAL";
  }

  return "UNPAID";
}

function extractPartialPayments(
  orders,
  partialPaymentEntries = [],
  reportType = "customer",
) {
  const partialPayments = [];

  if (Array.isArray(partialPaymentEntries)) {
    partialPaymentEntries.forEach((entry) => {
      const amount = Number(entry.amount || 0);
      if (amount > 0) {
        const isMfr = reportType === "manufacturer";
        partialPayments.push({
          orderNo: null,
          serialNo: entry.serialNo,
          amount,
          date: entry.date || entry.createdAt,
          paymentMode: entry.paymentMode || "-",
          remark: entry.remark ? String(entry.remark).trim() : "-",
          customerId: entry.customerId,
          manufacturerId: entry.manufacturerId,
          customerFirmName:
            (isMfr
              ? entry.manufacturer?.firmName
              : entry.customer?.firmName) || "",
          customerName:
            (isMfr ? entry.manufacturer?.name : entry.customer?.name) || "",
        });
      }
    });
  }

  if (reportType === "manufacturer") {
    return partialPayments;
  }

  orders.forEach((order) => {
    if (resolveOrderPaymentStatus(order) !== "PARTIAL") {
      return;
    }

    const poas = Array.isArray(order.paymentOrderAllocations)
      ? order.paymentOrderAllocations
      : [];
    const pas = Array.isArray(order.pendingPayment?.paymentAllocations)
      ? order.pendingPayment.paymentAllocations
      : [];
    const baseOrderNo = order.originalOrderNo || order.orderNo;
    const isCarryForward = Boolean(
      order.isCarryForward || order.carriedForwardFromOrderId,
    );
    const displayOrderNo = isCarryForward ? `${baseOrderNo}#` : baseOrderNo;

    if (poas.length > 0) {
      poas.forEach((alloc) => {
        const amount = Number(alloc.allocatedAmount || 0);
        if (amount > 0) {
          const entry = alloc.paymentEntry;
          partialPayments.push({
            orderNo: displayOrderNo,
            serialNo: entry?.serialNo,
            amount,
            date: entry?.date || alloc.createdAt,
            paymentMode: entry?.paymentMode || "-",
            remark: entry?.remark ? String(entry.remark).trim() : "-",
            customerId: order.customerId,
            customerFirmName: order.customer?.firmName || "",
            customerName: order.customer?.name || "",
          });
        }
      });
    } else if (pas.length > 0) {
      pas.forEach((alloc) => {
        const amount = Number(alloc.allocatedAmount || 0);
        if (amount > 0) {
          const receipt = alloc.paymentReceipt;
          partialPayments.push({
            orderNo: displayOrderNo,
            serialNo: receipt?.serialNo,
            amount,
            date:
              receipt?.paymentReceivedDate ||
              receipt?.date ||
              alloc.createdAt,
            paymentMode: receipt?.paymentMode || "-",
            remark: "-",
            customerId: order.customerId,
            customerFirmName: order.customer?.firmName || "",
            customerName: order.customer?.name || "",
          });
        }
      });
    } else {
      const received = Number(order.pendingPayment?.amountReceived || 0);
      if (received > 0) {
        partialPayments.push({
          orderNo: order.orderNo,
          amount: received,
          date: order.pendingPayment?.updatedAt || order.orderDate,
          paymentMode: "-",
          remark: "-",
          customerId: order.customerId,
          customerFirmName: order.customer?.firmName || "",
          customerName: order.customer?.name || "",
        });
      }
    }
  });

  return partialPayments;
}

function buildFinalTotalRows(
  finalTotals,
  partialPaymentEntries = [],
  orders = [],
  label = "",
  reportType = "customer",
) {
  const initialTotalRow = buildFinalTotalRow(finalTotals, label);
  const payments = extractPartialPayments(
    orders,
    partialPaymentEntries,
    reportType,
  );

  if (payments.length === 0) {
    return [initialTotalRow];
  }

  const totalPaymentsReceived = payments.reduce(
    (sum, p) => sum + roundCurrency(p.amount),
    0,
  );
  const netAmount = roundCurrency(finalTotals.amount - totalPaymentsReceived);

  const netLabel = label ? (label === "Grand Total" ? "Grand Net Total" : "Net Total") : "";
  const netTotalRow = {
    __highlight: true,
    amount: netAmount,
    lot: finalTotals.lot,
    quality: netLabel,
    meter: "",
    rate: "",
    orderId: "",
    date: "",
    partyFirmName: "",
    partyName: "",
    manufacturerFirmName: "",
    paymentStatus: "",
  };

  if (label === "Grand Total") {
    const summaryPaymentRow = {
      __mergeRest: true,
      amount: totalPaymentsReceived,
      details: "Total Payments Received",
    };
    return [initialTotalRow, summaryPaymentRow, netTotalRow];
  }

  const bannerRow = {
    __isBanner: true,
    text: "Payments Received:",
    bold: true,
  };

  const paymentRows = payments.map((p) => {
    const formattedDate = formatCellDate(p.date);
    const orderText = p.orderNo ? `Order #${p.orderNo} | ` : "";
    const remarkText =
      p.remark && p.remark !== "-" && p.remark.trim() ? p.remark.trim() : "-";
    const details = `${orderText}Date: ${formattedDate} | Mode: ${p.paymentMode} | Remark: ${remarkText}`;

    return {
      __mergeRest: true,
      amount: roundCurrency(p.amount),
      details,
    };
  });

  return [initialTotalRow, bannerRow, ...paymentRows, netTotalRow];
}

function matchesPaymentStatus(order, paymentStatusFilter) {
  const status = resolveOrderPaymentStatus(order);
  if (paymentStatusFilter === REPORT_PAYMENT_STATUS.PAID) {
    return status === "PAID";
  }
  if (paymentStatusFilter === REPORT_PAYMENT_STATUS.UNPAID) {
    return status === "UNPAID" || status === "PARTIAL";
  }
  return true;
}

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
  if (
    normalized === ORDER_STATUS.CANCELLED ||
    normalized === ORDER_STATUS.TRANSFERRED
  ) {
    throw new AppError("status must be one of: all, pending, completed", 400);
  }
  if (!Object.values(ORDER_STATUS).includes(normalized)) {
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
      400,
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

function getReportCompanyInfo(user) {
  return {
    address: user?.businessAddress || "",
    phone: user?.contactPhone || "",
  };
}

function getPartyDisplayName(party) {
  return String(party?.firmName || party?.name || "").trim();
}

function computeLotValue(order, scopeParty = null) {
  const party = scopeParty || order.customer;
  const isLotBasis =
    String(party?.commissionBase || "").toUpperCase() === "LOT";
  const lotRate = Number(party?.commissionLotRate || 0);
  const isManufacturer = party?.id && party.id === order.manufacturerId;
  const commissionAmount = Number(
    (isManufacturer
      ? order.manufacturerCommissionAmount
      : order.commissionAmount) ?? 0
  );

  if (isLotBasis && lotRate > 0 && commissionAmount > 0) {
    return Math.round(commissionAmount / lotRate);
  }

  // If order is TRANSFERRED, it fulfilled only its processed portion in this period
  if (order.status === ORDER_STATUS.TRANSFERRED) {
    const processedQty = safeNumber(order.processedQuantity);
    const unit = String(order.quantityUnit || "").toUpperCase();
    const lotMeters = safeNumber(order.lotMeters);
    if (unit === "LOT") {
      return Math.round(processedQty);
    }
    if (unit === "TAKKA") {
      return Math.round(processedQty / 12);
    }
    if (unit === "METER" && lotMeters > 0) {
      return Math.round(processedQty / lotMeters);
    }
  }

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
  const processed = safeNumber(order?.processedMeter);
  if (processed > 0) return round2(processed);
  return round2(safeNumber(order?.meter));
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

function parsePartyIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

async function getOrderFilters(query, userId) {
  const selectedFinancialYearStart =
    await getSelectedFinancialYearStartForUser(userId);
  const where = { userId, fyStartYear: selectedFinancialYearStart };
  const orderDate = buildDateFilter(query);
  if (orderDate) where.orderDate = orderDate;

  const customerIds = parsePartyIds(query.customerIds || query.customerId);
  if (customerIds.length === 1) {
    where.customerId = customerIds[0];
  } else if (customerIds.length > 1) {
    where.customerId = { in: customerIds };
  }

  const manufacturerIds = parsePartyIds(query.manufacturerIds || query.manufacturerId);
  if (manufacturerIds.length === 1) {
    where.manufacturerId = manufacturerIds[0];
  } else if (manufacturerIds.length > 1) {
    where.manufacturerId = { in: manufacturerIds };
  }

  if (query.qualityId) where.qualityId = query.qualityId;
  return where;
}

async function getSelectedReportParty(query, reportType, userId) {
  const isManufacturerReport = reportType === "manufacturer";
  const partyIds = parsePartyIds(
    isManufacturerReport
      ? query.manufacturerIds || query.manufacturerId
      : query.customerIds || query.customerId,
  );
  if (partyIds.length !== 1) {
    return null;
  }

  const where = { id: partyIds[0], userId };
  const select = {
    id: true,
    firmName: true,
    name: true,
    address: true,
    phone: true,
    commissionBase: true,
  };

  return isManufacturerReport
    ? prisma.manufacturer.findFirst({ where, select })
    : prisma.customer.findFirst({ where, select });
}

async function getSelectedReportParties(query, reportType, userId) {
  const isManufacturerReport = reportType === "manufacturer";
  const partyIds = parsePartyIds(
    isManufacturerReport
      ? query.manufacturerIds || query.manufacturerId
      : query.customerIds || query.customerId,
  );
  if (partyIds.length === 0) {
    return [];
  }

  const where = { id: { in: partyIds }, userId };
  const select = {
    id: true,
    firmName: true,
    name: true,
    address: true,
    phone: true,
    commissionBase: true,
  };

  return isManufacturerReport
    ? prisma.manufacturer.findMany({ where, select })
    : prisma.customer.findMany({ where, select });
}

function getOrderInclude() {
  return {
    user: { select: { id: true, name: true, email: true } },
    customer: true,
    manufacturer: true,
    quality: true,
    pendingPayment: {
      include: {
        paymentAllocations: {
          include: {
            paymentReceipt: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    },
    paymentOrderAllocations: {
      include: {
        paymentEntry: true,
      },
      orderBy: { createdAt: "asc" },
    },
  };
}

async function fetchOrders(where) {
  return prisma.order.findMany({
    where,
    orderBy: [{ orderDate: "desc" }, { orderNo: "desc" }],
    include: getOrderInclude(),
  });
}

function buildReportColumns(reportType, options = {}) {
  const partyColumns =
    reportType === "manufacturer"
      ? [
          { header: "Customer Firm", key: "partyFirmName", width: 24 },
          { header: "Customer Name", key: "partyName", width: 24 },
          { header: "Manufacturer Firm", key: "manufacturerFirmName", width: 24 },
        ]
      : [
          { header: "Manufacturer Firm", key: "partyFirmName", width: 24 },
          { header: "Manufacturer Name", key: "partyName", width: 24 },
        ];

  const cols = [
    { header: "Amount", key: "amount", width: 14 },
    { header: "LOT", key: "lot", width: 12 },
    { header: "Quality", key: "quality", width: 24 },
  ];

  if (options.includeMeter !== false) {
    cols.push({ header: "Meter", key: "meter", width: 14 });
  }

  cols.push(
    { header: "Rate", key: "rate", width: 12 },
    { header: "orderId", key: "orderId", width: 12 },
    { header: "Date", key: "date", width: 22 },
    ...partyColumns,
  );

  if (options.includePaymentStatus !== false) {
    cols.push({ header: "Payment Status", key: "paymentStatus", width: 16 });
  }

  return cols;
}

function orderToReportRow(
  order,
  reportType,
  paymentStatusFilter,
  manufacturerAccountStatusMap,
) {
  const party =
    reportType === "manufacturer" ? order.customer : order.manufacturer;
  let paymentStatus;
  if (reportType === "manufacturer" && manufacturerAccountStatusMap) {
    paymentStatus =
      manufacturerAccountStatusMap.get(order.manufacturerId) ||
      resolveOrderPaymentStatus(order);
  } else {
    paymentStatus = resolveOrderPaymentStatus(order);
  }
  const isPaid = paymentStatus === "PAID" || paymentStatus === "SETTLED";
  const shouldBold =
    (paymentStatusFilter === REPORT_PAYMENT_STATUS.PAID ||
      paymentStatusFilter === REPORT_PAYMENT_STATUS.ALL) &&
    isPaid;

  const resolvedManufacturerFirm =
    order.manufacturerFirmName || order.manufacturer?.firmName || "";
  const partyFirmName =
    reportType === "manufacturer"
      ? party?.firmName || ""
      : resolvedManufacturerFirm;

  const commissionAmount =
    reportType === "manufacturer"
      ? order.manufacturerCommissionAmount ?? 0
      : order.commissionAmount ?? 0;

  // If the party's commission basis is LOT, meter is not used in commission calculation
  const scopeParty =
    reportType === "manufacturer" ? order.manufacturer : order.customer;
  const isLotBasis =
    String(scopeParty?.commissionBase || "").toUpperCase() === "LOT";

  const meterValue = isLotBasis ? "" : computeMeterValue(order).toFixed(2);

  const baseOrderNo = order.originalOrderNo || order.orderNo;
  const isCarryForward = Boolean(
    order.isCarryForward || order.carriedForwardFromOrderId,
  );
  const displayOrderNo = isCarryForward ? `${baseOrderNo}#` : baseOrderNo;
  const transferDateStr = formatCellDate(order.orderDate);
  const originalDateStr = order.originalOrderDate
    ? formatCellDate(order.originalOrderDate)
    : "";
  const displayDate =
    originalDateStr && originalDateStr !== transferDateStr
      ? `${transferDateStr} (${originalDateStr})`
      : transferDateStr;

  return {
    amount: roundCurrency(commissionAmount),
    lot: computeLotValue(order, scopeParty),
    quality: order.quality?.name || "",
    meter: meterValue,
    rate: round2(order.rate).toFixed(2),
    orderId: displayOrderNo,
    date: displayDate,
    partyFirmName,
    partyName: party?.name || "",
    manufacturerFirmName: resolvedManufacturerFirm,
    paymentStatus,
    __bold: shouldBold,
  };
}

function computeReportTotals(orders, reportType = "customer") {
  return orders.reduce(
    (totals, order) => {
      const scopeParty =
        reportType === "manufacturer" ? order.manufacturer : order.customer;
      const commissionAmount =
        reportType === "manufacturer"
          ? order.manufacturerCommissionAmount ?? 0
          : order.commissionAmount ?? 0;
      totals.amount += roundCurrency(commissionAmount);
      totals.lot += Number(computeLotValue(order, scopeParty) || 0);
      return totals;
    },
    {
      amount: 0,
      lot: 0,
    },
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

function sortReportOrders(orders, groupBy = REPORT_GROUP_BY.DATE) {
  return [...orders].sort((a, b) => {
    if (groupBy === REPORT_GROUP_BY.QUALITY) {
      const qA = String(a.quality?.name || "").trim();
      const qB = String(b.quality?.name || "").trim();
      const qComp = qA.localeCompare(qB, undefined, { sensitivity: "base" });
      if (qComp !== 0) return qComp;
    } else if (groupBy === REPORT_GROUP_BY.MANUFACTURER) {
      const mA = String(a.manufacturer?.firmName || a.manufacturer?.name || "").trim();
      const mB = String(b.manufacturer?.firmName || b.manufacturer?.name || "").trim();
      const mComp = mA.localeCompare(mB, undefined, { sensitivity: "base" });
      if (mComp !== 0) return mComp;
    } else if (groupBy === REPORT_GROUP_BY.CUSTOMER) {
      const cA = String(a.customer?.firmName || a.customer?.name || "").trim();
      const cB = String(b.customer?.firmName || b.customer?.name || "").trim();
      const cComp = cA.localeCompare(cB, undefined, { sensitivity: "base" });
      if (cComp !== 0) return cComp;
    }

    const dateA = new Date(a.orderDate || 0).getTime();
    const dateB = new Date(b.orderDate || 0).getTime();
    if (dateA !== dateB) return dateA - dateB;
    return Number(a.orderNo || 0) - Number(b.orderNo || 0);
  });
}

function isSpecificScope(query, reportType) {
  if (reportType === "manufacturer") {
    const ids = parsePartyIds(query.manufacturerIds || query.manufacturerId);
    return ids.length === 1;
  }
  const ids = parsePartyIds(query.customerIds || query.customerId);
  return ids.length === 1;
}

function getScopeParty(order, reportType) {
  return reportType === "manufacturer" ? order.manufacturer : order.customer;
}

function getScopePartyLabel(reportType) {
  return reportType === "manufacturer" ? "Manufacturer" : "Customer";
}

function getScopeHeaderLines(party, reportType) {
  const partyLabel = getScopePartyLabel(reportType);
  const firmName = String(party?.firmName || "").trim();
  const personName = String(party?.name || "").trim();
  const lines = [];

  if (
    firmName &&
    personName &&
    firmName.toLowerCase() !== personName.toLowerCase()
  ) {
    lines.push(
      {
        value: `${partyLabel} Firm Name : ${firmName}`,
        alignment: "left",
        fontSize: 11,
        bold: true,
        height: 20,
        fill: true,
      },
      {
        value: `${partyLabel} Name : ${personName}`,
        alignment: "left",
        fontSize: 11,
        bold: true,
        height: 20,
        fill: true,
      },
    );
  } else if (firmName && !personName) {
    lines.push({
      value: `${partyLabel} Firm Name : ${firmName}`,
      alignment: "left",
      fontSize: 11,
      bold: true,
      height: 20,
      fill: true,
    });
  } else {
    lines.push({
      value: `${partyLabel} Name : ${personName || firmName || "-"}`,
      alignment: "left",
      fontSize: 11,
      bold: true,
      height: 20,
      fill: true,
    });
  }

  lines.push(
    {
      value: `Address   : ${String(party?.address || "-").trim() || "-"}`,
      alignment: "left",
      fontSize: 11,
      bold: true,
      height: 20,
      fill: true,
    },
    {
      value: `Mobile    : ${String(party?.phone || "-").trim() || "-"}`,
      alignment: "left",
      fontSize: 11,
      bold: true,
      height: 20,
      fill: true,
    },
  );

  return lines;
}

function getSelectedPartyHeaderLines(party, reportType) {
  const partyLabel = getScopePartyLabel(reportType);
  const firmName = String(party?.firmName || "").trim();
  const personName = String(party?.name || "").trim();
  const lines = [];

  if (
    firmName &&
    personName &&
    firmName.toLowerCase() !== personName.toLowerCase()
  ) {
    lines.push(
      {
        value: `${partyLabel} Firm Name : ${firmName}`,
        alignment: "left",
        fontSize: 11,
        bold: true,
        height: 20,
        fill: true,
      },
      {
        value: `${partyLabel} Name : ${personName}`,
        alignment: "left",
        fontSize: 11,
        bold: true,
        height: 20,
        fill: true,
      },
    );
  } else if (firmName && !personName) {
    lines.push({
      value: `${partyLabel} Firm Name : ${firmName}`,
      alignment: "left",
      fontSize: 11,
      bold: true,
      height: 20,
      fill: true,
    });
  } else {
    lines.push({
      value: `${partyLabel} Name : ${personName || firmName || "-"}`,
      alignment: "left",
      fontSize: 11,
      bold: true,
      height: 20,
      fill: true,
    });
  }

  lines.push(
    {
      value: `Address   : ${String(party?.address || "-").trim() || "-"}`,
      alignment: "left",
      fontSize: 11,
      bold: true,
      height: 20,
      fill: true,
    },
    {
      value: `Mobile    : ${String(party?.phone || "-").trim() || "-"}`,
      alignment: "left",
      fontSize: 11,
      bold: true,
      height: 20,
      fill: true,
    },
  );

  return lines;
}

function buildFinalTotalRow(finalTotals, label = "") {
  return {
    __highlight: true,
    amount: finalTotals.amount,
    lot: finalTotals.lot,
    quality: label,
    meter: "",
    rate: "",
    orderId: "",
    date: "",
    partyFirmName: "",
    partyName: "",
    manufacturerFirmName: "",
    paymentStatus: "",
  };
}

function getScopeSortLabel(scopeParty, reportType) {
  const label = reportType === "manufacturer" ? "Manufacturer" : "Customer";
  return String(
    scopeParty?.firmName || scopeParty?.name || `${label}: UNKNOWN`,
  ).trim();
}

function buildReportSections(
  orders,
  reportType,
  groupBy,
  query,
  paymentStatusFilter,
  partialPaymentEntries = [],
  manufacturerAccountStatusMap = new Map(),
  options = {},
) {
  const groupMap = new Map();
  const specificScope = isSpecificScope(query, reportType);
  const finalTotals = computeReportTotals(orders, reportType);
  const finalTotalRows = buildFinalTotalRows(
    finalTotals,
    partialPaymentEntries,
    orders,
    "Grand Total",
    reportType,
  );

  if (specificScope) {
    if (groupBy === REPORT_GROUP_BY.DATE) {
      const defaultTotalRows = buildFinalTotalRows(
        finalTotals,
        partialPaymentEntries,
        orders,
        "",
        reportType,
      );
      return [
        {
          showHeader: true,
          rows: [
            ...sortReportOrders(orders, groupBy).map((order) =>
              orderToReportRow(
                order,
                reportType,
                paymentStatusFilter,
                manufacturerAccountStatusMap,
              ),
            ),
            ...defaultTotalRows,
          ],
        },
      ];
    }

    // Grouping by quality, manufacturer, or customer
    const innerMap = new Map();
    orders.forEach((order) => {
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
        { sensitivity: "base" },
      ),
    );

    const sections = [];
    sortedInnerGroups.forEach((innerGroup, index) => {
      const isFirst = index === 0;
      const groupDisplayName = getGroupDisplayName(innerGroup.groupValue, groupBy);
      const groupOrders = sortReportOrders(innerGroup.orders, REPORT_GROUP_BY.DATE);
      const groupTotals = computeReportTotals(groupOrders, reportType);
      const groupTotalRow = buildFinalTotalRow(
        groupTotals,
        "",
      );

      const groupRows = groupOrders.map((order) =>
        orderToReportRow(
          order,
          reportType,
          paymentStatusFilter,
          manufacturerAccountStatusMap,
        ),
      );

      sections.push({
        showHeader: isFirst,
        rows: [
          ...groupRows,
          groupTotalRow,
        ],
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

    if (sortedInnerGroups.length > 1 || finalTotalRows.length > 1) {
      sections.push({
        showHeader: false,
        rows: finalTotalRows,
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
    }

    return sections;
  }

  // Multi-party scope (e.g. all customer report)
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
    getScopeSortLabel(left.scopeParty, reportType).localeCompare(
      getScopeSortLabel(right.scopeParty, reportType),
      undefined,
      { sensitivity: "base" },
    ),
  );

  const sections = [];
  const pageGap = Boolean(
    String(query?.pageGap ?? options?.pageGap ?? "").toLowerCase() === "true" ||
    query?.pageGap === true ||
    options?.pageGap === true,
  );
  const mainHeaderLines = options?.mainHeaderLines || [];

  sortedScopes.forEach((scopeGroup, scopeIndex) => {
    const isPageBreak = pageGap && scopeIndex > 0;
    const scopePartyId = scopeGroup.scopeParty?.id;
    const scopeTotals = computeReportTotals(scopeGroup.orders, reportType);
    const scopePartialEntries = Array.isArray(partialPaymentEntries)
      ? partialPaymentEntries.filter((e) =>
          reportType === "manufacturer"
            ? e.manufacturerId === scopePartyId
            : e.customerId === scopePartyId,
        )
      : [];
    const scopeTotalRows = buildFinalTotalRows(
      scopeTotals,
      scopePartialEntries,
      scopeGroup.orders,
      "",
      reportType,
    );

    if (groupBy === REPORT_GROUP_BY.DATE) {
      const sortedScopeOrders = sortReportOrders(scopeGroup.orders, groupBy);
      sections.push({
        pageBreakBefore: isPageBreak,
        headerLines: getScopeHeaderLines(scopeGroup.scopeParty, reportType),
        rows: [
          ...sortedScopeOrders.map((order) =>
            orderToReportRow(
              order,
              reportType,
              paymentStatusFilter,
              manufacturerAccountStatusMap,
            ),
          ),
          ...scopeTotalRows,
        ],
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

    // Multi-party with groupBy (quality, manufacturer, or customer)
    const innerMap = new Map();
    scopeGroup.orders.forEach((order) => {
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
        { sensitivity: "base" },
      ),
    );

    sortedInnerGroups.forEach((innerGroup, innerIndex) => {
      const isFirstInner = innerIndex === 0;
      const isLastInner = innerIndex === sortedInnerGroups.length - 1;
      const groupDisplayName = getGroupDisplayName(innerGroup.groupValue, groupBy);
      const groupOrders = sortReportOrders(innerGroup.orders, REPORT_GROUP_BY.DATE);
      const groupTotals = computeReportTotals(groupOrders, reportType);
      const groupTotalRow = buildFinalTotalRow(
        groupTotals,
        "",
      );

      const groupRows = groupOrders.map((order) =>
        orderToReportRow(
          order,
          reportType,
          paymentStatusFilter,
          manufacturerAccountStatusMap,
        ),
      );

      sections.push({
        pageBreakBefore: isFirstInner ? isPageBreak : false,
        headerLines: isFirstInner
          ? getScopeHeaderLines(scopeGroup.scopeParty, reportType)
          : [],
        showHeader: isFirstInner,
        rows: [
          ...groupRows,
          groupTotalRow,
          ...(isLastInner && (sortedInnerGroups.length > 1 || scopeTotalRows.length > 1) ? scopeTotalRows : []),
        ],
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

  const grandTotalRows = buildFinalTotalRows(
    finalTotals,
    partialPaymentEntries,
    orders,
    "Grand Total",
    reportType,
  );

  sections.push({
    showHeader: false,
    rows: grandTotalRows,
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

  return sections;
}

function buildReportHeaderLines(user, selectedParty, reportType) {
  const firmTitle = String(user?.firmName || user?.name || "Sauda Book").trim();
  const subtitle = String(user?.businessSubtitle || "").trim();
  const address = String(user?.businessAddress || "").trim();
  const phone = String(user?.contactPhone || "").trim();

  const lines = [
    {
      value: firmTitle,
      alignment: "center",
      fontSize: 16,
      bold: true,
      height: 26,
      fill: false,
    },
    subtitle
      ? {
          value: subtitle,
          alignment: "center",
          fontSize: 12,
          bold: true,
          height: 20,
          fill: false,
        }
      : null,
    address
      ? {
          value: address,
          alignment: "center",
          fontSize: 10,
          bold: false,
          height: 18,
          fill: false,
        }
      : null,
    phone
      ? {
          value: phone.startsWith("(M)") ? phone : `(M) ${phone}`,
          alignment: "center",
          fontSize: 11,
          bold: true,
          height: 18,
          fill: false,
        }
      : null,
  ].filter(Boolean);

  if (selectedParty) {
    lines.push(
      {
        value: "",
        height: 8,
        fill: false,
      },
      ...getSelectedPartyHeaderLines(selectedParty, reportType),
    );
  }

  return lines;
}

async function exportReportByType(req, res, reportType, format = "xlsx", options = {}) {
  const normalizedFormat = String(format || "xlsx").toLowerCase();
  const status = normalizeStatusFilter(req.query.status);
  const paymentStatus = normalizePaymentStatusFilter(req.query.paymentStatus);
  const groupBy = normalizeGroupByFilter(req.query.groupBy, reportType);
  const where = await getOrderFilters(req.query, req.user.userId);
  if (status) {
    if (status === ORDER_STATUS.COMPLETED) {
      where.OR = [
        { status: ORDER_STATUS.COMPLETED },
        {
          status: ORDER_STATUS.TRANSFERRED,
          OR: [
            { processedQuantity: { gt: 0 } },
            { processedMeter: { gt: 0 } },
            { commissionAmount: { gt: 0 } },
          ],
        },
      ];
    } else {
      where.status = status;
    }
  } else {
    where.OR = [
      { status: { in: [ORDER_STATUS.PENDING, ORDER_STATUS.COMPLETED] } },
      {
        status: ORDER_STATUS.TRANSFERRED,
        OR: [
          { processedQuantity: { gt: 0 } },
          { processedMeter: { gt: 0 } },
          { commissionAmount: { gt: 0 } },
        ],
      },
    ];
  }

  const isManufacturerReport = reportType === "manufacturer";
  const rawOrders = await fetchOrders(where);
  const selectedParty = await getSelectedReportParty(
    req.query,
    reportType,
    req.user.userId,
  );
  const selectedParties = await getSelectedReportParties(
    req.query,
    reportType,
    req.user.userId,
  );

  let baseFileName = "";
  if (selectedParty) {
    const rawPartyName = String(selectedParty.firmName || selectedParty.name || "").trim();
    // Sanitize party name for safe filename, replacing commas, symbols, and spaces with a single underscore
    const safePartyName = rawPartyName
      .replace(/[\\/:*?"<>|,;.]+/g, "_")
      .replace(/[\s_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    baseFileName = safePartyName || (isManufacturerReport ? "Manufacturer_Report" : "Customer_Report");
  } else if (selectedParties.length > 1) {
    const rawPartyNames = selectedParties
      .slice(0, 3)
      .map((p) => String(p.firmName || p.name || "").trim())
      .filter(Boolean)
      .join("_");
    const safePartyNames = rawPartyNames
      .replace(/[\\/:*?"<>|,;.]+/g, "_")
      .replace(/[\s_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    baseFileName = safePartyNames
      ? `${safePartyNames}${selectedParties.length > 3 ? `_and_${selectedParties.length - 3}_more` : ""}`
      : (isManufacturerReport ? "Manufacturers_Report" : "Customers_Report");
  } else {
    baseFileName = isManufacturerReport ? "All_Manufacturers_Report" : "All_Customers_Report";
  }

  const orientation =
    String(req.query.orientation || "portrait").toLowerCase() === "landscape"
      ? "landscape"
      : "portrait";
  const hidePaymentStatus =
    String(req.query.hidePaymentStatus || "").toLowerCase() === "true" ||
    String(req.query.showPaymentStatus || "").toLowerCase() === "false";
  const includePaymentStatus = !hidePaymentStatus;
  const isPartyLotBasis =
    selectedParty &&
    String(selectedParty.commissionBase || "").toUpperCase() === "LOT";
  const includeMeter = !isPartyLotBasis;

  const fileName = `${baseFileName}.${normalizedFormat === "pdf" ? "pdf" : "xlsx"}`;
  const sheetColumns = buildReportColumns(reportType, {
    includePaymentStatus,
    includeMeter,
  });
  const mainCompanyHeaderLines = buildReportHeaderLines(
    req.user,
    null,
    reportType,
  );
  const headerLines = buildReportHeaderLines(
    req.user,
    selectedParty,
    reportType,
  );

  let orders = [];
  let partialPaymentEntries = [];
  const manufacturerAccountStatusMap = new Map();

  if (isManufacturerReport) {
    const queryPartyIds = parsePartyIds(req.query.manufacturerIds || req.query.manufacturerId);
    const partyIds = [
      ...new Set(
        [
          ...queryPartyIds,
          ...rawOrders.map((o) => o.manufacturerId),
        ].filter(Boolean),
      ),
    ];

    let manufacturerPaymentEntries = [];
    if (partyIds.length > 0) {
      manufacturerPaymentEntries = await prisma.paymentEntry.findMany({
        where: {
          userId: req.user.userId,
          partyType: "MANUFACTURER",
          manufacturerId: { in: partyIds },
        },
        include: {
          manufacturer: { select: { id: true, name: true, firmName: true } },
        },
        orderBy: [{ date: "asc" }, { serialNo: "asc" }],
      });
    }

    // Compute account-level status for each manufacturer
    partyIds.forEach((mfrId) => {
      const mfrOrders = rawOrders.filter((o) => o.manufacturerId === mfrId);
      const totalCommission = roundCurrency(
        mfrOrders.reduce(
          (sum, o) => sum + Number(o.manufacturerCommissionAmount ?? 0),
          0,
        ),
      );
      const mfrPayments = manufacturerPaymentEntries.filter(
        (p) => p.manufacturerId === mfrId,
      );
      const totalPaid = roundCurrency(
        mfrPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0),
      );
      const hasSettledPayment = mfrPayments.some((p) => p.isFullySettled);

      let status = "UNPAID";
      if (
        hasSettledPayment ||
        (totalCommission > 0 && totalPaid >= totalCommission) ||
        (totalCommission === 0 && totalPaid > 0)
      ) {
        status = "PAID";
      } else if (totalPaid > 0) {
        status = "PARTIAL";
      }

      manufacturerAccountStatusMap.set(mfrId, status);
    });

    // Filter orders according to manufacturer's account payment status
    orders = rawOrders.filter((order) => {
      const mfrStatus =
        manufacturerAccountStatusMap.get(order.manufacturerId) || "UNPAID";
      if (paymentStatus === REPORT_PAYMENT_STATUS.PAID) {
        return mfrStatus === "PAID";
      }
      if (paymentStatus === REPORT_PAYMENT_STATUS.UNPAID) {
        return mfrStatus === "UNPAID" || mfrStatus === "PARTIAL";
      }
      return true;
    });

    // Only include payment entries for manufacturers that are present in the report
    const includedMfrIds = new Set(
      orders.length > 0
        ? orders.map((o) => o.manufacturerId)
        : queryPartyIds,
    );
    partialPaymentEntries = manufacturerPaymentEntries.filter((p) =>
      includedMfrIds.has(p.manufacturerId),
    );
  } else {
    // Customer report logic
    orders = rawOrders.filter((order) =>
      matchesPaymentStatus(order, paymentStatus),
    );

    const queryCustomerIds = parsePartyIds(req.query.customerIds || req.query.customerId);
    const partyIds = [
      ...new Set(
        [
          ...queryCustomerIds,
          ...orders.map((o) => o.customerId),
          ...rawOrders.map((o) => o.customerId),
        ].filter(Boolean),
      ),
    ];

    if (partyIds.length > 0 && paymentStatus !== REPORT_PAYMENT_STATUS.PAID) {
      partialPaymentEntries = await prisma.paymentEntry.findMany({
        where: {
          userId: req.user.userId,
          customerId: { in: partyIds },
          adjustedAgainst: "PARTIAL",
          isFullySettled: false,
        },
        include: {
          customer: { select: { id: true, name: true, firmName: true } },
        },
        orderBy: [{ date: "asc" }, { serialNo: "asc" }],
      });
    }
  }

  const sheetConfig = {
    headerLines,
    columns: sheetColumns,
    sections: buildReportSections(
      orders,
      reportType,
      groupBy,
      req.query,
      paymentStatus,
      partialPaymentEntries,
      manufacturerAccountStatusMap,
      {
        pageGap: req.query.pageGap,
      },
    ),
  };

  if (normalizedFormat === "pdf") {
    const disposition = String(req.query.disposition || options?.disposition || "attachment").toLowerCase();
    await sendPdfReport(res, fileName, [sheetConfig], { orientation, disposition });
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

const createReportShareLink = asyncHandler(async (req, res) => {
  const userType = normalizeUserTypeFilter(req.query.userType || req.body.userType);

  const params = {
    userType,
    from: req.body.from ?? req.query.from,
    to: req.body.to ?? req.query.to,
    customerId: req.body.customerId ?? req.query.customerId,
    customerIds: req.body.customerIds ?? req.query.customerIds,
    manufacturerId: req.body.manufacturerId ?? req.query.manufacturerId,
    manufacturerIds: req.body.manufacturerIds ?? req.query.manufacturerIds,
    qualityId: req.body.qualityId ?? req.query.qualityId,
    status: req.body.status ?? req.query.status,
    paymentStatus: req.body.paymentStatus ?? req.query.paymentStatus,
    groupBy: req.body.groupBy ?? req.query.groupBy,
    orientation: req.body.orientation || req.query.orientation || "portrait",
    pageGap: req.body.pageGap ?? req.query.pageGap,
    showPaymentStatus:
      req.body.showPaymentStatus !== undefined
        ? req.body.showPaymentStatus
        : req.query.showPaymentStatus,
    userId: req.user.userId,
  };

  const selectedParties = await getSelectedReportParties(
    params,
    userType === "MANUFACTURER" ? "manufacturer" : "customer",
    req.user.userId,
  );
  let party = null;
  if (selectedParties.length === 1) {
    party = selectedParties[0];
  } else if (selectedParties.length > 1) {
    // Combine names for WhatsApp message
    const combinedFirmNames = selectedParties
      .map((p) => p.firmName || p.name)
      .filter(Boolean)
      .join(", ");
    // Find first party with a phone number
    const partyWithPhone = selectedParties.find((p) => p.phone);
    party = {
      name: selectedParties[0].name,
      firmName: combinedFirmNames,
      phone: partyWithPhone?.phone || "",
    };
  }

  let shareToken = null;
  try {
    // Generate a clean 8-character unique short code
    const code = crypto.randomBytes(4).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await prisma.reportShare.create({
      data: {
        code,
        userId: req.user.userId,
        payload: params,
        expiresAt,
      },
    });
    shareToken = code;
  } catch (dbErr) {
    // Fallback to stateless signed JWT if ReportShare table has not been migrated to DB yet
    shareToken = createReportShareToken({
      userId: req.user.userId,
      ...params,
    });
  }

  const publicBase =
    process.env.PUBLIC_REPORTS_URL ||
    (process.env.NODE_ENV === "production" ? "https://api.saudabook.co.in" : null);
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  const baseUrl = publicBase || `${protocol}://${host}`;
  const shareUrl = `${baseUrl}/api/reports/shared/${shareToken}.pdf`;

  const partyName = party
    ? (party.firmName || party.name)
    : (userType === "MANUFACTURER" ? "All Manufacturers" : "All Customers");
  const dateRangeStr =
    params.from && params.to ? `${params.from} to ${params.to}` : "All Records";

  const whatsappText = `📄 *Statement of Account*
*Firm*: ${partyName}
*Period*: ${dateRangeStr}

👉 *View / Download your Official PDF Statement:*
${shareUrl}

_Generated via Sauda Book_`;

  res.json({
    success: true,
    shareToken,
    shareUrl,
    party: party
      ? {
          name: party.name,
          firmName: party.firmName,
          phone: party.phone,
        }
      : null,
    whatsappText,
  });
});

const exportSharedReportPdf = asyncHandler(async (req, res) => {
  let rawToken = req.params.shareToken;
  if (rawToken && rawToken.endsWith(".pdf")) {
    rawToken = rawToken.slice(0, -4);
  }

  let payload = null;

  // 1. Try finding by short code in database
  let shareRecord = null;
  try {
    shareRecord = await prisma.reportShare.findUnique({
      where: { code: rawToken },
    });
  } catch (_dbErr) {
    // Database table might not exist yet; fall back directly to JWT
  }

  if (shareRecord) {
    if (shareRecord.expiresAt && shareRecord.expiresAt < new Date()) {
      throw new AppError("This report share link has expired", 401);
    }
    payload = shareRecord.payload;
  } else {
    // 2. Fallback to verifying as JWT token
    try {
      payload = verifyReportShareToken(rawToken);
    } catch (_err) {
      throw new AppError("Invalid or expired report share link", 401);
    }
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      firmName: true,
      businessSubtitle: true,
      contactPhone: true,
      businessAddress: true,
      subscriptionPlan: true,
      subscriptionStatus: true,
      billingCycle: true,
      trialEndsAt: true,
      planExpiresAt: true,
    },
  });

  if (!user) {
    throw new AppError("Report owner account not found", 404);
  }

  req.user = { userId: user.id, ...user };
  req.query = {
    ...payload,
    disposition: "inline",
  };

  const reportType =
    payload.userType === REPORT_USER_TYPE.MANUFACTURER
      ? "manufacturer"
      : "customer";
  await exportReportByType(req, res, reportType, "pdf", { disposition: "inline" });
});

module.exports = {
  exportOrderReport,
  exportCustomerReport,
  exportManufacturerReport,
  exportOrderReportPdf,
  exportCustomerReportPdf,
  exportManufacturerReportPdf,
  createReportShareLink,
  exportSharedReportPdf,
};
