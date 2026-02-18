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

function buildManufacturerMessage(order) {
  return [
    `${order.manufacturer.gstNo}`,
    `${order.manufacturer.name}`,
    `${order.manufacturer.address}`,
    `Quality: ${order.quality.name}`,
    `Qty: ${order.quantity}`,
    `Rate: ₹ ${formatRate(order.rate)} + GST`,
    `Order No: ${order.orderNo}`,
    `Order Date: ${formatDate(order.orderDate)}`,
    `Customer: ${order.customer.name}`,
    `Created By: ${order.user.name || order.user.email}`,
  ].join("\n");
}

function buildCustomerMessage(order) {
  return [
    `${order.customer.gstNo}`,
    `${order.customer.name}`,
    `${order.customer.address}`,
    `Quality: ${order.quality.name}`,
    `Qty: ${order.quantity}`,
    `Rate: ₹ ${formatRate(order.rate)} + GST`,
    `Order No: ${order.orderNo}`,
    `Order Date: ${formatDate(order.orderDate)}`,
    `Manufacturer: ${order.manufacturer.name}`,
    `Created By: ${order.user.name || order.user.email}`,
  ].join("\n");
}

function buildOrderWhatsAppLinks(order) {
  const manufacturerMessage = buildManufacturerMessage(order);
  const customerMessage = buildCustomerMessage(order);

  return {
    manufacturer: buildWhatsAppLink(manufacturerMessage, order.manufacturer?.phone),
    customer: buildWhatsAppLink(customerMessage, order.customer?.phone),
  };
}

module.exports = {
  buildOrderWhatsAppLinks,
};
