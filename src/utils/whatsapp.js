function toIndianWhatsAppNumber(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) {
    return null;
  }

  if (digits.startsWith("91") && digits.length === 12) {
    return digits;
  }

  if (digits.length < 10) {
    return null;
  }

  const lastTenDigits = digits.slice(-10);
  return `91${lastTenDigits}`;
}

function buildWhatsAppLink(message, phone) {
  const normalizedPhone = toIndianWhatsAppNumber(phone);
  if (!normalizedPhone) {
    return null;
  }
  return `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(message)}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toISOString().slice(0, 10);
}

function formatRate(rate) {
  const numberRate = Number(rate);
  if (Number.isNaN(numberRate)) {
    return String(rate);
  }
  return numberRate.toFixed(2);
}

function resolvePaymentDueDays(order, { addExtraDays = 0 } = {}) {
  const due = Number(order?.paymentDueOn);
  if (!Number.isFinite(due) || due < 0) {
    return "-";
  }
  return String(due + addExtraDays);
}

function buildCustomerStyleMessage(
  order,
  { addExtraPaymentDueDays = 0, includeManufacturerName = true } = {}
) {
  const quantityLabel = order.quantityUnit
    ? `${order.quantity} ${order.quantityUnit}`
    : `${order.quantity}`;
  const paymentDueDays = resolvePaymentDueDays(order, {
    addExtraDays: addExtraPaymentDueDays,
  });
  const remark = String(order?.remarks || "").trim();

  return [
    "*ORDER CONFIRMATION*",
    "",
    `*Party:* ${order.customer.name}`,
    `*GST:* ${order.customer.gstNo || "-"}`,
    `*Address:* ${order.customer.address}`,
    "",
    "*Order Details*",
    `- Quality: ${order.quality.name}`,
    `- Qty: ${quantityLabel}`,
    `- Rate: Rs. ${formatRate(order.rate)} + GST`,
    `- Payment Dhara: ${paymentDueDays} days`,
    ...(remark ? [`- Remark: ${remark}`] : []),
    "",
    `*Order No:* ${order.orderNo}`,
    `*Order Date:* ${formatDate(order.orderDate)}`,
    ...(includeManufacturerName ? [`*Manufacturer:* ${order.manufacturer.name}`] : []),
    `*Created By:* ${order.user.name || order.user.email}`,
  ].join("\n");
}

function buildOrderWhatsAppLinks(order) {
  const customerMessage = buildCustomerStyleMessage(order);
  const manufacturerMessage = buildCustomerStyleMessage(order, {
    addExtraPaymentDueDays: 5,
    includeManufacturerName: false,
  });

  return {
    manufacturer: buildWhatsAppLink(manufacturerMessage, order.manufacturer?.phone),
    customer: buildWhatsAppLink(customerMessage, order.customer?.phone),
  };
}

module.exports = {
  buildOrderWhatsAppLinks,
};
