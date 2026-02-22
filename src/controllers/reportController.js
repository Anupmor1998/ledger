const prisma = require("../config/prisma");
const asyncHandler = require("../utils/asyncHandler");
const { sendWorkbook } = require("../utils/reportExcel");

const ORDER_STATUS = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
};

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function buildDateFilter(query) {
  const { from, to } = query;
  if (!from && !to) return undefined;

  const filter = {};
  if (from) filter.gte = new Date(from);
  if (to) filter.lte = new Date(to);
  return filter;
}

function getOrderFilters(query, userId) {
  const where = { userId };
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

const REPORT_COLUMNS = [
  { header: "Commission Amt", key: "commissionAmt" },
  { header: "LOT", key: "lot" },
  { header: "Qulaity", key: "quality" },
  { header: "Meter", key: "meter" },
  { header: "Rate", key: "rate" },
  { header: "Date", key: "date" },
  { header: "Manufacture Firmname", key: "manufacturerFirmname" },
  { header: "Manufacturer contact name", key: "manufacturerContactName" },
];

function orderToReportRow(order) {
  return {
    commissionAmt: toNumber(order.commissionAmount),
    lot: order.quantityUnit === "LOT" ? toNumber(order.quantity) : "",
    quality: order.quality?.name || "",
    // Only show user-entered meter quantity (unit = METER), never random calculated meter.
    meter: order.quantityUnit === "METER" ? toNumber(order.quantity) : "",
    rate: toNumber(order.rate),
    date: formatDate(order.orderDate),
    manufacturerFirmname: order.manufacturer?.firmName || "",
    manufacturerContactName: order.manufacturer?.name || "",
  };
}

async function sendStandardReport(res, fileName, orders) {
  const rows = orders.map(orderToReportRow);
  await sendWorkbook(res, fileName, [
    {
      name: "Report",
      columns: REPORT_COLUMNS,
      rows,
    },
  ]);
}

function withStatus(where, status) {
  if (!status) return where;
  return { ...where, status };
}

const exportOrderRegisterReport = asyncHandler(async (req, res) => {
  const orders = await fetchOrders(getOrderFilters(req.query, req.user.userId));
  await sendStandardReport(res, "order-register.xlsx", orders);
});

const exportOrderProgressReport = asyncHandler(async (req, res) => {
  const where = withStatus(getOrderFilters(req.query, req.user.userId), ORDER_STATUS.PENDING);
  const orders = await fetchOrders(where);
  await sendStandardReport(res, "order-progress.xlsx", orders);
});

const exportCompletedSettlementReport = asyncHandler(async (req, res) => {
  const where = withStatus(getOrderFilters(req.query, req.user.userId), ORDER_STATUS.COMPLETED);
  const orders = await fetchOrders(where);
  await sendStandardReport(res, "completed-settlement.xlsx", orders);
});

const exportCancelledOrdersReport = asyncHandler(async (req, res) => {
  const where = withStatus(getOrderFilters(req.query, req.user.userId), ORDER_STATUS.CANCELLED);
  const orders = await fetchOrders(where);
  await sendStandardReport(res, "cancelled-orders.xlsx", orders);
});

const exportManufacturerCommissionReport = asyncHandler(async (req, res) => {
  const where = withStatus(getOrderFilters(req.query, req.user.userId), ORDER_STATUS.COMPLETED);
  const orders = await fetchOrders(where);
  const sortedByManufacturer = [...orders].sort((a, b) =>
    (a.manufacturer?.firmName || a.manufacturer?.name || "").localeCompare(
      b.manufacturer?.firmName || b.manufacturer?.name || ""
    )
  );
  await sendStandardReport(
    res,
    "manufacturer-commission.xlsx",
    sortedByManufacturer
  );
});

module.exports = {
  exportOrderRegisterReport,
  exportOrderProgressReport,
  exportCompletedSettlementReport,
  exportCancelledOrdersReport,
  exportManufacturerCommissionReport,
};
