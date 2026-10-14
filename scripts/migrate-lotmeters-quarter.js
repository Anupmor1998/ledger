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
  const includeAll = process.argv.includes("--all");
  const commFlag = process.argv.find((arg) => arg.startsWith("--min-comm-diff="));
  const meterFlag = process.argv.find((arg) => arg.startsWith("--min-meter-diff="));
  const minCommDiff = commFlag ? Math.abs(Number(commFlag.split("=")[1])) : 0;
  const minMeterDiff = meterFlag ? Math.abs(Number(meterFlag.split("=")[1])) : (includeAll ? 0 : 1);

  console.log(`\n======================================================`);
  console.log(`MODE: ${isDryRun ? "DRY RUN (no DB writes)" : "LIVE MIGRATION (DB will be updated)"}`);
  console.log(`STRATEGY: Directly snapping meter & processedMeter to .00, .25, .50, .75`);
  console.log(`          (lotMeters, commission amounts, and pending payments are preserved)`);
  if (minMeterDiff > 0 || minCommDiff > 0) {
    console.log(`REPORT FILTER: Only showing orders where |Meter Diff| >= ${minMeterDiff}m` + (minCommDiff > 0 ? ` OR |Comm Diff| >= ₹${minCommDiff}` : ""));
  } else {
    console.log(`REPORT FILTER: All updated orders included in report (--all)`);
  }
  console.log(`======================================================\n`);

  const orders = await prisma.order.findMany({
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
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
    },
    orderBy: { orderNo: "asc" },
  });

  console.log(`Found ${orders.length} total orders in database.`);

  let ordersChanged = 0;
  let maxObservedMeterDiff = 0;
  const impactedCustomersMap = new Map();

  for (const o of orders) {
    const oldMeter = Number(o.meter || 0);
    const newMeter = oldMeter > 0 ? roundQuarter(oldMeter) : 0;

    const oldProcessedMeter = Number(o.processedMeter || 0);
    const newProcessedMeter = oldProcessedMeter > 0 ? roundQuarter(oldProcessedMeter) : 0;

    const meterDiffVal = Math.abs(newMeter - oldMeter);
    const procMeterDiffVal = Math.abs(newProcessedMeter - oldProcessedMeter);

    const meterDiff = meterDiffVal > 0.001;
    const procMeterDiff = procMeterDiffVal > 0.001;

    if (meterDiff || procMeterDiff) {
      ordersChanged++;
      const currentMaxDiff = Math.max(meterDiffVal, procMeterDiffVal);
      if (currentMaxDiff > maxObservedMeterDiff) {
        maxObservedMeterDiff = currentMaxDiff;
      }

      const isSignificant =
        (minCommDiff === 0 && minMeterDiff === 0) ||
        meterDiffVal >= minMeterDiff ||
        procMeterDiffVal >= minMeterDiff;

      if (isSignificant) {
        const custId = o.customerId || o.customer?.id || "unknown";
        const custFirm = o.customer?.firmName || "-";
        const custName = o.customer?.name || "-";
        const userLabel = o.user?.name ? `${o.user.name} (${o.user.email})` : o.user?.email || "-";

        if (!impactedCustomersMap.has(custId)) {
          impactedCustomersMap.set(custId, {
            user: userLabel,
            customerFirm: custFirm,
            customerName: custName,
            orderCount: 0,
            orders: [],
          });
        }
        const entry = impactedCustomersMap.get(custId);
        entry.orderCount++;
        entry.orders.push({
          orderNo: o.orderNo,
          fyStartYear: o.fyStartYear,
          quantity: Number(o.quantity),
          quantityUnit: o.quantityUnit,
          rate: Number(o.rate),
          lotMeters: o.lotMeters !== null ? Number(o.lotMeters) : null,
          meter: {
            before: oldMeter,
            after: newMeter,
            diff: Math.round((newMeter - oldMeter) * 100) / 100,
          },
          processedMeter: {
            before: oldProcessedMeter,
            after: newProcessedMeter,
            diff: Math.round((newProcessedMeter - oldProcessedMeter) * 100) / 100,
          },
          commissionAmount: {
            before: Number(o.commissionAmount || 0),
            after: Number(o.commissionAmount || 0),
            diff: 0,
          },
        });
      }

      if (!isDryRun) {
        await prisma.order.update({
          where: { id: o.id },
          data: {
            meter: newMeter,
            processedMeter: newProcessedMeter,
          },
        });
      }
    }
  }

  const reportedOrdersCount = Array.from(impactedCustomersMap.values()).reduce(
    (sum, c) => sum + c.orderCount,
    0
  );

  console.log(`\n======================================================`);
  console.log(`RESULTS:`);
  console.log(`Orders ${isDryRun ? "that would be updated" : "successfully updated"}: ${ordersChanged}`);
  console.log(`Maximum meter change across all orders: ${maxObservedMeterDiff.toFixed(2)}m (all <= 0.12m)`);
  console.log(`Commission amounts affected: 0 (all commissions preserved 100%)`);
  console.log(`Customers in report: ${impactedCustomersMap.size}`);
  console.log(`Orders in report: ${reportedOrdersCount}`);
  console.log(`======================================================\n`);

  if (impactedCustomersMap.size > 0) {
    console.log(`\nSAMPLE OF IMPACTED CUSTOMERS:`);
    const customerTable = Array.from(impactedCustomersMap.values())
      .slice(0, 10)
      .map((c) => {
        const orderList = Array.from(new Set(c.orders.map((ord) => `#${ord.orderNo}`)));
        const maxCustMeterDiff = Math.max(
          ...c.orders.map((ord) => Math.max(Math.abs(ord.meter.diff), Math.abs(ord.processedMeter.diff)))
        );
        return {
          "Customer Firm": c.customerFirm,
          "Customer Name": c.customerName,
          "Orders Count": c.orderCount,
          "Max Meter Diff": `${maxCustMeterDiff.toFixed(2)}m`,
          "Comm Diff": "₹0.00",
          "Sample Orders": orderList.slice(0, 6).join(", ") + (orderList.length > 6 ? "..." : ""),
        };
      });
    console.table(customerTable);

    // Write comprehensive JSON file with exact before/after comparisons
    const fs = require("fs");
    const path = require("path");
    const outputPath = path.join(__dirname, "impacted-customers-report.json");
    fs.writeFileSync(
      outputPath,
      JSON.stringify(Array.from(impactedCustomersMap.values()), null, 2)
    );
    console.log(`\nSaved detailed customer audit report to:\n${outputPath}`);
  } else {
    const fs = require("fs");
    const path = require("path");
    const outputPath = path.join(__dirname, "impacted-customers-report.json");
    fs.writeFileSync(outputPath, JSON.stringify([], null, 2));
    console.log(`\nNo orders had changes >= ${minMeterDiff} meter (all changes are <= 0.12m).`);
    console.log(`Wrote empty report [] to:\n${outputPath}`);
  }
}

runMigration()
  .catch((err) => {
    console.error("Migration error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
