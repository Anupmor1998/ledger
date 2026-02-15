const prisma = require("../config/prisma");
const asyncHandler = require("../utils/asyncHandler");
const { sendWorkbook } = require("../utils/reportExcel");

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

function getOrderFilters(query) {
  const where = {};
  const orderDate = buildDateFilter(query);
  if (orderDate) where.orderDate = orderDate;
  if (query.customerId) where.customerId = query.customerId;
  if (query.manufacturerId) where.manufacturerId = query.manufacturerId;
  if (query.qualityId) where.qualityId = query.qualityId;
  if (query.userId) where.userId = query.userId;
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

function orderToDetailedRow(order) {
  const rate = toNumber(order.rate);
  const quantity = toNumber(order.quantity);
  return {
    orderNo: order.orderNo,
    orderDate: formatDate(order.orderDate),
    customerName: order.customer.name,
    customerGstNo: order.customer.gstNo,
    manufacturerName: order.manufacturer.name,
    manufacturerGstNo: order.manufacturer.gstNo,
    quality: order.quality.name,
    quantity,
    rate,
    amount: quantity * rate,
    createdBy: order.user.name || order.user.email,
    createdAt: formatDate(order.createdAt),
  };
}

async function fetchOrders(where) {
  return prisma.order.findMany({
    where,
    orderBy: { orderDate: "desc" },
    include: getOrderInclude(),
  });
}

const exportOrdersReport = asyncHandler(async (req, res) => {
  const orders = await fetchOrders(getOrderFilters(req.query));
  const rows = orders.map(orderToDetailedRow);

  await sendWorkbook(res, "orders-report.xlsx", [
    {
      name: "Orders",
      columns: [
        { header: "Order No", key: "orderNo" },
        { header: "Order Date", key: "orderDate" },
        { header: "Customer", key: "customerName" },
        { header: "Customer GST", key: "customerGstNo" },
        { header: "Manufacturer", key: "manufacturerName" },
        { header: "Manufacturer GST", key: "manufacturerGstNo" },
        { header: "Quality", key: "quality" },
        { header: "Quantity", key: "quantity" },
        { header: "Rate", key: "rate" },
        { header: "Amount", key: "amount" },
        { header: "Created By", key: "createdBy" },
        { header: "Created At", key: "createdAt" },
      ],
      rows,
    },
  ]);
});

const exportDateRangeSummaryReport = asyncHandler(async (req, res) => {
  const orders = await fetchOrders(getOrderFilters(req.query));
  const summaryMap = new Map();

  orders.forEach((order) => {
    const date = formatDate(order.orderDate);
    const rate = toNumber(order.rate);
    const quantity = toNumber(order.quantity);
    const amount = rate * quantity;
    const current = summaryMap.get(date) || { date, orders: 0, quantity: 0, amount: 0 };
    current.orders += 1;
    current.quantity += quantity;
    current.amount += amount;
    summaryMap.set(date, current);
  });

  const rows = Array.from(summaryMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  await sendWorkbook(res, "date-range-summary.xlsx", [
    {
      name: "Date Summary",
      columns: [
        { header: "Date", key: "date" },
        { header: "Total Orders", key: "orders" },
        { header: "Total Quantity", key: "quantity" },
        { header: "Total Amount", key: "amount" },
      ],
      rows,
    },
  ]);
});

function groupByEntity(orders, entityKey, gstKeyName, nameKeyName) {
  const map = new Map();
  orders.forEach((order) => {
    const entity = order[entityKey];
    const key = entity.id;
    const rate = toNumber(order.rate);
    const quantity = toNumber(order.quantity);
    const amount = rate * quantity;
    const current = map.get(key) || {
      [nameKeyName]: entity.name,
      [gstKeyName]: entity.gstNo,
      orders: 0,
      quantity: 0,
      averageRate: 0,
      amount: 0,
      _rateTotal: 0,
    };

    current.orders += 1;
    current.quantity += quantity;
    current._rateTotal += rate;
    current.averageRate = current._rateTotal / current.orders;
    current.amount += amount;
    map.set(key, current);
  });

  return Array.from(map.values()).map((item) => {
    const { _rateTotal, ...clean } = item;
    return clean;
  });
}

const exportCustomerReport = asyncHandler(async (req, res) => {
  const orders = await fetchOrders(getOrderFilters(req.query));
  const rows = groupByEntity(orders, "customer", "gstNo", "customerName");

  await sendWorkbook(res, "customer-summary.xlsx", [
    {
      name: "Customer Summary",
      columns: [
        { header: "Customer", key: "customerName" },
        { header: "GST No", key: "gstNo" },
        { header: "Total Orders", key: "orders" },
        { header: "Total Quantity", key: "quantity" },
        { header: "Average Rate", key: "averageRate" },
        { header: "Total Amount", key: "amount" },
      ],
      rows,
    },
  ]);
});

const exportManufacturerReport = asyncHandler(async (req, res) => {
  const orders = await fetchOrders(getOrderFilters(req.query));
  const rows = groupByEntity(orders, "manufacturer", "gstNo", "manufacturerName");

  await sendWorkbook(res, "manufacturer-summary.xlsx", [
    {
      name: "Manufacturer Summary",
      columns: [
        { header: "Manufacturer", key: "manufacturerName" },
        { header: "GST No", key: "gstNo" },
        { header: "Total Orders", key: "orders" },
        { header: "Total Quantity", key: "quantity" },
        { header: "Average Rate", key: "averageRate" },
        { header: "Total Amount", key: "amount" },
      ],
      rows,
    },
  ]);
});

const exportQualityReport = asyncHandler(async (req, res) => {
  const orders = await fetchOrders(getOrderFilters(req.query));
  const map = new Map();

  orders.forEach((order) => {
    const key = order.quality.id;
    const rate = toNumber(order.rate);
    const quantity = toNumber(order.quantity);
    const amount = rate * quantity;
    const current = map.get(key) || {
      quality: order.quality.name,
      orders: 0,
      quantity: 0,
      averageRate: 0,
      amount: 0,
      _rateTotal: 0,
    };

    current.orders += 1;
    current.quantity += quantity;
    current._rateTotal += rate;
    current.averageRate = current._rateTotal / current.orders;
    current.amount += amount;
    map.set(key, current);
  });

  const rows = Array.from(map.values()).map(({ _rateTotal, ...rest }) => rest);

  await sendWorkbook(res, "quality-summary.xlsx", [
    {
      name: "Quality Summary",
      columns: [
        { header: "Quality", key: "quality" },
        { header: "Total Orders", key: "orders" },
        { header: "Total Quantity", key: "quantity" },
        { header: "Average Rate", key: "averageRate" },
        { header: "Total Amount", key: "amount" },
      ],
      rows,
    },
  ]);
});

const exportUserActivityReport = asyncHandler(async (req, res) => {
  const orders = await fetchOrders(getOrderFilters(req.query));
  const map = new Map();

  orders.forEach((order) => {
    const key = order.user.id;
    const rate = toNumber(order.rate);
    const quantity = toNumber(order.quantity);
    const amount = rate * quantity;
    const current = map.get(key) || {
      userName: order.user.name || order.user.email,
      userEmail: order.user.email,
      orders: 0,
      quantity: 0,
      amount: 0,
    };
    current.orders += 1;
    current.quantity += quantity;
    current.amount += amount;
    map.set(key, current);
  });

  const rows = Array.from(map.values());

  await sendWorkbook(res, "user-activity.xlsx", [
    {
      name: "User Activity",
      columns: [
        { header: "User", key: "userName" },
        { header: "Email", key: "userEmail" },
        { header: "Total Orders", key: "orders" },
        { header: "Total Quantity", key: "quantity" },
        { header: "Total Amount", key: "amount" },
      ],
      rows,
    },
  ]);
});

const exportGstSummaryReport = asyncHandler(async (req, res) => {
  const orders = await fetchOrders(getOrderFilters(req.query));
  const map = new Map();

  orders.forEach((order) => {
    const amount = toNumber(order.rate) * toNumber(order.quantity);
    const entries = [
      { type: "Customer", name: order.customer.name, gstNo: order.customer.gstNo },
      { type: "Manufacturer", name: order.manufacturer.name, gstNo: order.manufacturer.gstNo },
    ];

    entries.forEach((entry) => {
      const key = `${entry.type}:${entry.gstNo}`;
      const current = map.get(key) || {
        partyType: entry.type,
        partyName: entry.name,
        gstNo: entry.gstNo,
        orders: 0,
        amount: 0,
      };
      current.orders += 1;
      current.amount += amount;
      map.set(key, current);
    });
  });

  const rows = Array.from(map.values());

  await sendWorkbook(res, "gst-summary.xlsx", [
    {
      name: "GST Summary",
      columns: [
        { header: "Type", key: "partyType" },
        { header: "Name", key: "partyName" },
        { header: "GST No", key: "gstNo" },
        { header: "Order Count", key: "orders" },
        { header: "Total Amount", key: "amount" },
      ],
      rows,
    },
  ]);
});

const exportRecentOrdersReport = asyncHandler(async (req, res) => {
  const days = Number(req.query.days || 7);
  const from = new Date();
  from.setDate(from.getDate() - days);
  const where = {
    ...getOrderFilters(req.query),
    orderDate: {
      gte: from,
      ...(buildDateFilter(req.query) || {}),
    },
  };

  const orders = await fetchOrders(where);
  const rows = orders.map(orderToDetailedRow);

  await sendWorkbook(res, "recent-orders.xlsx", [
    {
      name: "Recent Orders",
      columns: [
        { header: "Order No", key: "orderNo" },
        { header: "Order Date", key: "orderDate" },
        { header: "Customer", key: "customerName" },
        { header: "Manufacturer", key: "manufacturerName" },
        { header: "Quality", key: "quality" },
        { header: "Quantity", key: "quantity" },
        { header: "Rate", key: "rate" },
        { header: "Amount", key: "amount" },
      ],
      rows,
    },
  ]);
});

function topRowsByEntity(orders, entityKey, titleKey, limit = 10) {
  const map = new Map();
  orders.forEach((order) => {
    const entity = order[entityKey];
    const key = entity.id;
    const amount = toNumber(order.rate) * toNumber(order.quantity);
    const quantity = toNumber(order.quantity);
    const current = map.get(key) || {
      [titleKey]: entity.name,
      orders: 0,
      quantity: 0,
      amount: 0,
    };
    current.orders += 1;
    current.quantity += quantity;
    current.amount += amount;
    map.set(key, current);
  });

  return Array.from(map.values())
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

const exportTopCustomersReport = asyncHandler(async (req, res) => {
  const limit = Number(req.query.limit || 10);
  const orders = await fetchOrders(getOrderFilters(req.query));
  const rows = topRowsByEntity(orders, "customer", "customer", limit);

  await sendWorkbook(res, "top-customers.xlsx", [
    {
      name: "Top Customers",
      columns: [
        { header: "Customer", key: "customer" },
        { header: "Orders", key: "orders" },
        { header: "Quantity", key: "quantity" },
        { header: "Amount", key: "amount" },
      ],
      rows,
    },
  ]);
});

const exportTopManufacturersReport = asyncHandler(async (req, res) => {
  const limit = Number(req.query.limit || 10);
  const orders = await fetchOrders(getOrderFilters(req.query));
  const rows = topRowsByEntity(orders, "manufacturer", "manufacturer", limit);

  await sendWorkbook(res, "top-manufacturers.xlsx", [
    {
      name: "Top Manufacturers",
      columns: [
        { header: "Manufacturer", key: "manufacturer" },
        { header: "Orders", key: "orders" },
        { header: "Quantity", key: "quantity" },
        { header: "Amount", key: "amount" },
      ],
      rows,
    },
  ]);
});

const exportLedgerReport = asyncHandler(async (req, res) => {
  const orders = await fetchOrders(getOrderFilters(req.query));
  const rows = orders.map((order) => ({
    voucherDate: formatDate(order.orderDate),
    voucherNo: order.orderNo,
    customer: order.customer.name,
    manufacturer: order.manufacturer.name,
    quality: order.quality.name,
    particulars: `${order.quality.name} (${order.quantity} x ${toNumber(order.rate).toFixed(2)})`,
    quantity: toNumber(order.quantity),
    rate: toNumber(order.rate),
    debit: toNumber(order.quantity) * toNumber(order.rate),
    credit: 0,
    createdBy: order.user.name || order.user.email,
  }));

  await sendWorkbook(res, "ledger-report.xlsx", [
    {
      name: "Ledger",
      columns: [
        { header: "Date", key: "voucherDate" },
        { header: "Voucher No", key: "voucherNo" },
        { header: "Customer", key: "customer" },
        { header: "Manufacturer", key: "manufacturer" },
        { header: "Quality", key: "quality" },
        { header: "Particulars", key: "particulars" },
        { header: "Quantity", key: "quantity" },
        { header: "Rate", key: "rate" },
        { header: "Debit", key: "debit" },
        { header: "Credit", key: "credit" },
        { header: "Created By", key: "createdBy" },
      ],
      rows,
    },
  ]);
});

module.exports = {
  exportOrdersReport,
  exportDateRangeSummaryReport,
  exportCustomerReport,
  exportManufacturerReport,
  exportQualityReport,
  exportUserActivityReport,
  exportGstSummaryReport,
  exportRecentOrdersReport,
  exportTopCustomersReport,
  exportTopManufacturersReport,
  exportLedgerReport,
};
