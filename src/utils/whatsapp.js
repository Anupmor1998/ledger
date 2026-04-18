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
  const from = order?.deliveryDateFrom ? formatDate(order.deliveryDateFrom) : "";
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
    recipient === "MANUFACTURER" ? order?.manufacturerRemark || "" : order?.customerRemark || ""
  ).trim();

  return joinRemarkParts([commonRemark, recipientRemark]);
}

function buildCustomerStyleMessage(
  order,
  { addExtraPaymentDueDays = 0, includeManufacturerName = true, recipient = "CUSTOMER" } = {}
) {
  const customerDisplay = order.customer?.firmName || order.customer?.name || "-";
  const manufacturerContact = order.manufacturer?.name || "-";
  const manufacturerFirmName = order.manufacturer?.firmName?.trim() || "";
  const customerContactName = order.customer?.name || customerDisplay;
  const customerPhone = String(order.customer?.phone || "").trim();
  const customerContactLine = customerPhone
    ? `${customerContactName} (${customerPhone})`
    : customerContactName;
  const quantityLabel = order.quantityUnit
    ? `${order.quantity} ${order.quantityUnit}`
    : `${order.quantity}`;
  const paymentDueDays = resolvePaymentDueDays(order, {
    addExtraDays: addExtraPaymentDueDays,
  });
  const deliveryRange = buildDeliveryRange(order);
  const mergedRemark = buildMergedRemark(order, recipient);
  const showDyeingGuarantees = recipient === "MANUFACTURER" && Boolean(order?.dyeingGuarantees);
  const qualityLine = showDyeingGuarantees
    ? `- Quality: ${order.quality.name}, डाइंग गारंटी`
    : `- Quality: ${order.quality.name}`;

  return [
    `*Order No:* ${order.orderNo}`,
    `*Order Date:* ${formatDate(order.orderDate)}`,
    "",
    `*Party:* ${customerDisplay}`,
    `*GST:* ${order.customer.gstNo || "-"}`,
    `*Address:* ${order.customer.address}`,
    "",
    "*Order Details*",
    qualityLine,
    `- Qty: ${quantityLabel}`,
    `- Rate: ${formatRate(order.rate)} + GST`,
    ...(deliveryRange ? [`- Delivery: ${deliveryRange}`] : []),
    `- Payment Dhara: ${paymentDueDays} days`,
    ...(mergedRemark ? [`- Remark: ${mergedRemark}`] : []),
    ...(recipient === "MANUFACTURER"
      ? ["", `डिलेवरी भेजो तब चालान की फोटु भेजना मेरे को आप ।`]
      : []),
    "",
    ...(includeManufacturerName
      ? [manufacturerContact, ...(manufacturerFirmName ? [`(${manufacturerFirmName})`] : [])]
      : [`*Contact No:* ${customerContactLine}`]),
    order.user.name || order.user.email,
  ].join("\n");
}

function buildOrderWhatsAppLinks(order) {
  const messages = buildOrderWhatsAppMessages(order);

  return {
    manufacturer: buildWhatsAppLink(messages.manufacturer, order.manufacturer?.phone),
    customer: buildWhatsAppLink(messages.customer, order.customer?.phone),
  };
}

function buildOrderWhatsAppMessages(order) {
  const customerMessage = buildCustomerStyleMessage(order, {
    recipient: "CUSTOMER",
  });
  const manufacturerMessage = buildCustomerStyleMessage(order, {
    addExtraPaymentDueDays: 5,
    includeManufacturerName: false,
    recipient: "MANUFACTURER",
  });

  return {
    manufacturer: manufacturerMessage,
    customer: customerMessage,
  };
}

module.exports = {
  buildOrderWhatsAppLinks,
  buildOrderWhatsAppMessages,
};
