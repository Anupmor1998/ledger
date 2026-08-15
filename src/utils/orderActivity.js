const ORDER_ACTIVITY_ACTIONS = {
  CREATED: "CREATED",
  UPDATED: "UPDATED",
  PROGRESS_UPDATED: "PROGRESS_UPDATED",
  DELETED: "DELETED",
  CARRIED_FORWARD: "CARRIED_FORWARD",
  REOPENED: "REOPENED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
};

const AUDIT_FIELDS = [
  "status",
  "rate",
  "quantity",
  "lot",
  "processedQuantity",
  "processedMeter",
  "quantityUnit",
  "lotMeters",
  "meter",
  "commissionAmount",
  "remarks",
  "customerRemark",
  "manufacturerRemark",
  "dyeingGuarantees",
  "paymentDueOn",
  "deliveryDateFrom",
  "deliveryDateTo",
  "fyStartYear",
  "orderNo",
  "isCarryForward",
  "carriedForwardFromOrderId",
  "transferBatchId",
  "orderDate",
  "customerId",
  "manufacturerId",
  "qualityId",
];

function toSerializableValue(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value === undefined) {
    return null;
  }
  if (value && typeof value === "object" && "toString" in value && value.constructor?.name === "Decimal") {
    return value.toString();
  }
  return value;
}

function buildOrderAuditSnapshot(order) {
  if (!order) {
    return null;
  }

  const snapshot = {};
  AUDIT_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(order, field)) {
      snapshot[field] = toSerializableValue(order[field]);
    }
  });

  snapshot.id = order.id;
  snapshot.customerName = order.customer?.firmName || order.customer?.name || null;
  snapshot.manufacturerName = order.manufacturer?.firmName || order.manufacturer?.name || null;
  snapshot.qualityName = order.quality?.name || null;

  return snapshot;
}

function getChangedFields(beforeSnapshot, afterSnapshot) {
  const keys = new Set([
    ...Object.keys(beforeSnapshot || {}),
    ...Object.keys(afterSnapshot || {}),
  ]);

  return Array.from(keys).filter((key) => {
    const beforeValue = JSON.stringify(beforeSnapshot?.[key] ?? null);
    const afterValue = JSON.stringify(afterSnapshot?.[key] ?? null);
    return beforeValue !== afterValue;
  });
}

async function recordOrderActivity(tx, { userId, orderId, action, beforeData, afterData, metadata }) {
  if (!tx?.orderActivity?.create) {
    return null;
  }

  return tx.orderActivity.create({
    data: {
      userId,
      orderId,
      action,
      beforeData: beforeData ?? null,
      afterData: afterData ?? null,
      metadata: metadata ?? null,
    },
  });
}

module.exports = {
  ORDER_ACTIVITY_ACTIONS,
  buildOrderAuditSnapshot,
  getChangedFields,
  recordOrderActivity,
};
