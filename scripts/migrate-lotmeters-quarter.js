require("dotenv").config();
const prisma = require("../src/config/prisma");

const TAKKA_PER_LOT = 12;
const GST_RATE = 0.05;
const DEFAULT_COMMISSION_PERCENT = 1;

function roundQuarter(value) {
  const num = Number(value || 0);
  return Math.round(num * 4) / 4;
}

function roundCurrency(value) {
  return Math.round(Number(value || 0));
}

function snapLotMetersToQuarter(value) {
  if (!Number.isFinite(value) || value <= 0) return 1450.5;
  const whole = Math.floor(value);
  const frac = value - whole;
  const quarterSteps = [0.25, 0.5, 0.75];
  let closest = quarterSteps[0];
  let minDiff = Math.abs(frac - closest);
  for (let i = 1; i < quarterSteps.length; i++) {
    const diff = Math.abs(frac - quarterSteps[i]);
    if (diff < minDiff) {
      minDiff = diff;
      closest = quarterSteps[i];
    }
  }
  return whole + closest;
}

function toMeterFromQuantity({ quantity, quantityUnit, lotMeters }) {
  if (quantityUnit === "METER") {
    return roundQuarter(quantity);
  }
  if (!Number.isFinite(lotMeters) || lotMeters <= 0) {
    throw new Error("lot meter value is required");
  }
  if (quantityUnit === "LOT") {
    return roundQuarter(quantity * lotMeters);
  }
  return roundQuarter(quantity * (lotMeters / TAKKA_PER_LOT));
}

function toLotQuantity({ quantity, quantityUnit, lotMeters }) {
  if (quantityUnit === "LOT") return quantity;
  if (quantityUnit === "TAKKA") return quantity / TAKKA_PER_LOT;
  return quantity / lotMeters;
}

function computeCommissionAmount({
  quantityForCommission,
  rate,
  quantityUnit,
  lotMeters,
  customerCommissionConfig,
}) {
  if (!Number.isFinite(quantityForCommission) || quantityForCommission <= 0) {
    return 0;
  }
  const commissionBase = String(customerCommissionConfig?.commissionBase || "PERCENT").toUpperCase();
  const commissionPercent =
    Number(customerCommissionConfig?.commissionPercent) > 0
      ? Number(customerCommissionConfig?.commissionPercent)
      : DEFAULT_COMMISSION_PERCENT;
  const commissionLotRate = Number(customerCommissionConfig?.commissionLotRate || 0);

  if (commissionBase === "LOT") {
    const lotQuantity = toLotQuantity({
      quantity: quantityForCommission,
      quantityUnit,
      lotMeters,
    });
    return roundCurrency(lotQuantity * commissionLotRate);
  }

  const meter = toMeterFromQuantity({
    quantity: quantityForCommission,
    quantityUnit,
    lotMeters,
  });
  const baseAmount = meter * rate;
  const gstAmount = baseAmount * GST_RATE;
  return roundCurrency((baseAmount + gstAmount) * (commissionPercent / 100));
}

function computeManufacturerCommissionAmount({
  quantityForCommission,
  rate,
  quantityUnit,
  lotMeters,
  manufacturerCommissionConfig,
}) {
  if (!Number.isFinite(quantityForCommission) || quantityForCommission <= 0) {
    return 0;
  }
  const commissionBase = String(manufacturerCommissionConfig?.commissionBase || "LOT").toUpperCase();
  const commissionPercent = Number(manufacturerCommissionConfig?.commissionPercent || 0);
  const commissionLotRate = Number(manufacturerCommissionConfig?.commissionLotRate || 0);

  if (commissionBase === "LOT") {
    if (commissionLotRate <= 0) return 0;
    const lotQuantity = toLotQuantity({
      quantity: quantityForCommission,
      quantityUnit,
      lotMeters,
    });
    return roundCurrency(lotQuantity * commissionLotRate);
  }

  if (commissionPercent <= 0) return 0;
  const meter = toMeterFromQuantity({
    quantity: quantityForCommission,
    quantityUnit,
    lotMeters,
  });
  const baseAmount = meter * rate;
  const gstAmount = baseAmount * GST_RATE;
  return roundCurrency((baseAmount + gstAmount) * (commissionPercent / 100));
}

async function runMigration() {
  const isDryRun = process.argv.includes("--dry-run");
  const cutoff = new Date("2026-08-22T20:50:49+05:30");

  console.log(`\n======================================================`);
  console.log(`MODE: ${isDryRun ? "DRY RUN (no DB writes)" : "LIVE MIGRATION (DB will be updated)"}`);
  console.log(`======================================================\n`);

  // Target orders created before the August 22, 2026 cutoff that have lotMeters,
  // or any TAKKA/LOT order whose meter is not cleanly snapped to quarter decimals.
  const orders = await prisma.order.findMany({
    where: {
      lotMeters: { not: null },
    },
    include: {
      customer: {
        select: {
          id: true,
          name: true,
          firmName: true,
          commissionBase: true,
          commissionPercent: true,
          commissionLotRate: true,
        },
      },
      manufacturer: {
        select: {
          id: true,
          name: true,
          firmName: true,
          commissionBase: true,
          commissionPercent: true,
          commissionLotRate: true,
        },
      },
      pendingPayment: true,
    },
    orderBy: { orderNo: "asc" },
  });

  console.log(`Found ${orders.length} total orders with lotMeters in database.`);

  let ordersChanged = 0;
  let pendingPaymentsChanged = 0;
  const impactedCustomersMap = new Map();

  for (const o of orders) {
    const oldLotMeters = Number(o.lotMeters);
    const newLotMeters = snapLotMetersToQuarter(oldLotMeters);

    const oldMeter = Number(o.meter);
    const newMeter = toMeterFromQuantity({
      quantity: Number(o.quantity),
      quantityUnit: o.quantityUnit,
      lotMeters: newLotMeters,
    });

    const oldProcessedMeter = Number(o.processedMeter);
    let newProcessedMeter = oldProcessedMeter;
    if (oldProcessedMeter > 0) {
      newProcessedMeter = roundQuarter(oldProcessedMeter);
    }

    const newComm =
      o.status === "COMPLETED"
        ? computeCommissionAmount({
            quantityForCommission: Number(o.processedQuantity || o.quantity),
            rate: Number(o.rate),
            quantityUnit: o.quantityUnit,
            lotMeters: newLotMeters,
            customerCommissionConfig: o.customer,
          })
        : Number(o.commissionAmount);

    const newMfrComm =
      o.status === "COMPLETED"
        ? computeManufacturerCommissionAmount({
            quantityForCommission: Number(o.processedQuantity || o.quantity),
            rate: Number(o.rate),
            quantityUnit: o.quantityUnit,
            lotMeters: newLotMeters,
            manufacturerCommissionConfig: o.manufacturer,
          })
        : Number(o.manufacturerCommissionAmount || 0);

    const lotMetersDiff = Math.abs(oldLotMeters - newLotMeters) > 0.001;
    const meterDiff = Math.abs(oldMeter - newMeter) > 0.001;
    const procMeterDiff = Math.abs(oldProcessedMeter - newProcessedMeter) > 0.001;

    if (lotMetersDiff || meterDiff || procMeterDiff) {
      ordersChanged++;

      // Track customer
      const custId = o.customerId || o.customer?.id || "unknown";
      const custFirm = o.customer?.firmName || "-";
      const custName = o.customer?.name || "-";
      if (!impactedCustomersMap.has(custId)) {
        impactedCustomersMap.set(custId, {
          firmName: custFirm,
          customerName: custName,
          orderCount: 0,
          orderNumbers: [],
        });
      }
      const entry = impactedCustomersMap.get(custId);
      entry.orderCount++;
      if (entry.orderNumbers.length < 8) {
        entry.orderNumbers.push(o.orderNo);
      }

      if (!isDryRun) {
        await prisma.$transaction(async (tx) => {
          await tx.order.update({
            where: { id: o.id },
            data: {
              lotMeters: newLotMeters,
              meter: newMeter,
              processedMeter: newProcessedMeter,
              commissionAmount: newComm,
              manufacturerCommissionAmount: newMfrComm,
            },
          });

          if (o.pendingPayment && o.status === "COMPLETED") {
            const received = Number(o.pendingPayment.amountReceived || 0);
            const newBalance = Math.max(newComm - received, 0);
            await tx.pendingPayment.update({
              where: { id: o.pendingPayment.id },
              data: {
                amountDue: newComm,
                balanceAmount: newBalance,
              },
            });
            pendingPaymentsChanged++;
          }
        });
      }
    }
  }

  console.log(`\n======================================================`);
  console.log(`RESULTS:`);
  console.log(`Orders ${isDryRun ? "that would be updated" : "successfully updated"}: ${ordersChanged}`);
  console.log(`Pending payments ${isDryRun ? "that would be synced" : "synced"}: ${pendingPaymentsChanged}`);
  console.log(`Unique customers affected: ${impactedCustomersMap.size}`);
  console.log(`======================================================\n`);

  if (impactedCustomersMap.size > 0) {
    console.log(`\nLIST OF IMPACTED CUSTOMERS:`);
    const customerTable = Array.from(impactedCustomersMap.values()).map((c) => ({
      "Customer Firm": c.firmName,
      "Customer Name": c.customerName,
      "Updated Orders": c.orderCount,
      "Sample Order #": c.orderNumbers.join(", ") + (c.orderCount > 8 ? "..." : ""),
    }));
    console.table(customerTable);

    // Optional: write JSON summary file for easy sharing or verification
    const fs = require("fs");
    const path = require("path");
    const outputPath = path.join(__dirname, "impacted-customers-report.json");
    fs.writeFileSync(
      outputPath,
      JSON.stringify(Array.from(impactedCustomersMap.values()), null, 2)
    );
    console.log(`Saved customer list report to: ${outputPath}`);
  }
}

runMigration()
  .catch((err) => {
    console.error("Migration error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
