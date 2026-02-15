const TEST_WHATSAPP_NUMBER = "9537244302";

function buildWhatsAppLink(message, phone = TEST_WHATSAPP_NUMBER) {
  const cleanedPhone = String(phone).replace(/\D/g, "");
  return `https://wa.me/${cleanedPhone}?text=${encodeURIComponent(message)}`;
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
    manufacturer: buildWhatsAppLink(manufacturerMessage),
    customer: buildWhatsAppLink(customerMessage),
  };
}

module.exports = {
  buildOrderWhatsAppLinks,
  TEST_WHATSAPP_NUMBER,
};
