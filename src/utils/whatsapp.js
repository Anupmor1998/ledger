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
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
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

function buildDeliveryRange(order) {
  const from = order?.deliveryDateFrom
    ? formatDate(order.deliveryDateFrom)
    : "";
  const to = order?.deliveryDateTo ? formatDate(order.deliveryDateTo) : "";

  if (from && to) {
    return `${from} to ${to}`;
  }
  return from || to || "";
}

function joinRemarkParts(parts) {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");
}

function buildMergedRemark(order, recipient) {
  const commonRemark = String(order?.remarks || "").trim();
  const recipientRemark = String(
    recipient === "MANUFACTURER"
      ? order?.manufacturerRemark || ""
      : order?.customerRemark || "",
  ).trim();

  return joinRemarkParts([commonRemark, recipientRemark]);
}

function buildPartyDisplay(order) {
  return order.customer?.firmName || order.customer?.name || "-";
}

function buildCustomerContactLine(order) {
  const contactName = order.customer?.name || buildPartyDisplay(order);
  const phone = String(order.customer?.phone || "").trim();
  return phone ? `${contactName} (${phone})` : contactName;
}

function buildManufacturerDisplay(order) {
  const firmName = String(order.manufacturer?.firmName || "").trim();
  const manufacturerName = String(order.manufacturer?.name || "").trim();

  if (firmName && manufacturerName) {
    return `${firmName} (${manufacturerName})`;
  }

  return firmName || manufacturerName || "-";
}

function buildBrokerDisplay(order) {
  return order.user?.name || order.user?.email || "-";
}

function buildOrderDetailLines(order, paymentDueDays, recipient, mergedRemark) {
  const quantityLabel = order.quantityUnit
    ? `${order.quantity} ${order.quantityUnit}`
    : `${order.quantity}`;
  const deliveryRange = buildDeliveryRange(order);
  const showDyeingGuarantees =
    recipient === "MANUFACTURER" && Boolean(order?.dyeingGuarantees);
  const qualityLine = showDyeingGuarantees
    ? `- Quality: ${order.quality.name}, डाइंग गारंटी`
    : `- Quality: ${order.quality.name}`;

  return [
    qualityLine,
    `- Qty: ${quantityLabel}`,
    `- Rate: ${formatRate(order.rate)} + GST`,
    ...(deliveryRange ? [`- Delivery: ${deliveryRange}`] : []),
    `- Payment Dhara: ${paymentDueDays} days`,
    ...(mergedRemark ? [`- Remark: ${mergedRemark}`] : []),
  ];
}

function buildManufacturerMessage(order) {
  const paymentDueDays = resolvePaymentDueDays(order, { addExtraDays: 5 });
  const mergedRemark = buildMergedRemark(order, "MANUFACTURER");

  return [
    `Order No: ${order.orderNo}`,
    `Date: ${formatDate(order.orderDate)}`,
    "",
    `Party: ${buildPartyDisplay(order)}`,
    `Contact No: ${buildCustomerContactLine(order)}`,
    `GST: ${order.customer?.gstNo || "-"}`,
    `Address: ${order.customer?.address || "-"}`,
    "",
    "Order Details",
    ...buildOrderDetailLines(
      order,
      paymentDueDays,
      "MANUFACTURER",
      mergedRemark,
    ),
    "",
    "डिलेवरी भेजो तब चालान की फोटु भेजना ।",
    "चालान में Order No. लिख कर भेजना ।",
    "",
    `Broker - ${buildBrokerDisplay(order)}`,
  ].join("\n");
}

function buildCustomerMessage(order) {
  const paymentDueDays = resolvePaymentDueDays(order);
  const mergedRemark = buildMergedRemark(order, "CUSTOMER");

  return [
    `*Order No:* ${order.orderNo}`,
    `*Date:* ${formatDate(order.orderDate)}`,
    "",
    `*Party:* ${buildPartyDisplay(order)}`,
    `*GST:* ${order.customer?.gstNo || "-"}`,
    `*Address:* ${order.customer?.address || "-"}`,
    "",
    "*Order Details*",
    ...buildOrderDetailLines(order, paymentDueDays, "CUSTOMER", mergedRemark),
    "",
    `Manufactures - ${buildManufacturerDisplay(order)}`,
    "",
    `Broker - ${buildBrokerDisplay(order)}`,
  ].join("\n");
}

function buildOrderWhatsAppLinks(order) {
  const messages = buildOrderWhatsAppMessages(order);

  return {
    manufacturer: buildWhatsAppLink(
      messages.manufacturer,
      order.manufacturer?.phone,
    ),
    customer: buildWhatsAppLink(messages.customer, order.customer?.phone),
  };
}

function buildOrderWhatsAppMessages(order) {
  return {
    manufacturer: buildManufacturerMessage(order),
    customer: buildCustomerMessage(order),
  };
}

module.exports = {
  buildOrderWhatsAppLinks,
  buildOrderWhatsAppMessages,
};
