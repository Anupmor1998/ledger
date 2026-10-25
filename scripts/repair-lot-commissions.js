/**
 * scripts/repair-lot-commissions.js
 * 
 * Production repair script for lot-based order commissions.
 * 
 * Safely repairs historical commission amounts on orders where LOT-based commissions:
 *   1. Were computed with unrounded fractional lots on METER or TAKKA conversion (e.g. Order #21).
 *   2. Suffered from roll-meter variance during dispatch/completion:
 *      - Minor shortfall (e.g. Orders #870, #882 where 7.03 or 7.47 lots were delivered on an 8 lot order -> 8 lots).
 *      - Minor over-delivery (e.g. Order #764 where 12.87 lots were delivered on a 12 lot order -> rounded to nearest integer: 13 lots).
 * 
 * Also recalibrates linked pending payment records (amountDue and balanceAmount)
 * inside an atomic database transaction.
 * 
 * Usage:
 *   node scripts/repair-lot-commissions.js             # Dry-run (scans and prints changes without saving)
 *   node scripts/repair-lot-commissions.js --apply     # Applies the fixes inside a database transaction
 *   node scripts/repair-lot-commissions.js --apply --user=moolchandvadera601@gmail.com
 */

require('dotenv').config();
const prisma = require('../src/config/prisma');
const { syncPendingPaymentAmounts } = require('../src/utils/payments');

const isApply = process.argv.includes('--apply');
const userArg = process.argv.find((a) => a.startsWith('--user='));
const targetUserEmail = userArg ? userArg.split('=')[1] : null;

function computeBookedLots(order) {
  if (order.lot !== null && order.lot !== undefined && order.lot !== '') {
    return Math.round(Number(order.lot));
  }
  const qty = Number(order.quantity || 0);
  const unit = String(order.quantityUnit || '').toUpperCase();
  const lotMeters = Number(order.lotMeters || 0);

  if (unit === 'LOT') return Math.round(qty);
  if (unit === 'TAKKA') return Math.round(qty / 12);
  if (unit === 'METER' && lotMeters > 0) return Math.round(qty / lotMeters);
  return 0;
}

function computeDeliveredLots(order) {
  const unit = String(order.quantityUnit || '').toUpperCase();
  const lotMeters = Number(order.lotMeters || 0);
  const processedQty = Number(order.processedQuantity || 0);
  const processedMeter = Number(order.processedMeter || 0);

  if (unit === 'LOT') return processedQty;
  if (unit === 'TAKKA') return processedQty / 12;
  if (processedMeter > 0 && lotMeters > 0) return processedMeter / lotMeters;
  if (processedQty > 0 && lotMeters > 0) return processedQty / lotMeters;
  return 0;
}

async function run() {
  console.log('='.repeat(70));
  console.log(`PRODUCTION LOT COMMISSION REPAIR SCRIPT`);
  console.log(`MODE: ${isApply ? 'APPLY (Writing changes to DB)' : 'DRY-RUN (Safe mode - no writes)'}`);
  if (targetUserEmail) console.log(`FILTER: Target User = ${targetUserEmail}`);
  console.log('='.repeat(70));

  const whereClause = targetUserEmail
    ? { user: { email: targetUserEmail } }
    : {};

  const orders = await prisma.order.findMany({
    where: whereClause,
    include: {
      customer: true,
      manufacturer: true,
      user: { select: { email: true } },
      pendingPayment: true,
    },
    orderBy: [{ fyStartYear: 'asc' }, { orderNo: 'asc' }],
  });

  const repairs = [];

  for (const o of orders) {
    const bookedLots = computeBookedLots(o);
    const deliveredLots = computeDeliveredLots(o);
    const isCompleted = o.status === 'COMPLETED';

    let needsMfrUpdate = false;
    let newMfrComm = Number(o.manufacturerCommissionAmount || 0);

    let needsCustUpdate = false;
    let newCustComm = Number(o.commissionAmount || 0);

    // ----------------------------------------------------
    // 1. Manufacturer LOT check (Creation METER conversion only)
    // ----------------------------------------------------
    const mfrBase = String(o.manufacturer?.commissionBase || 'LOT').toUpperCase();
    const mfrLotRate = Number(o.manufacturer?.commissionLotRate || 0);

    if (mfrBase === 'LOT' && mfrLotRate > 0 && bookedLots > 0) {
      const storedMfr = Number(o.manufacturerCommissionAmount || 0);
      if (o.quantityUnit === 'METER' && Number(o.lotMeters || 0) > 0) {
        const rawLots = Number(o.quantity) / Number(o.lotMeters);
        if (rawLots % 1 !== 0) {
          const expected = bookedLots * mfrLotRate;
          const unrounded = Math.round(rawLots * mfrLotRate);
          if (storedMfr !== expected && (storedMfr === unrounded || Math.abs(storedMfr - expected) <= 10)) {
            needsMfrUpdate = true;
            newMfrComm = expected;
          }
        }
      }
    }

    // ----------------------------------------------------
    // 2. Customer LOT check (Creation conversion & Roll variance)
    // ----------------------------------------------------
    const custBase = String(o.customer?.commissionBase || 'PERCENT').toUpperCase();
    const custLotRate = Number(o.customer?.commissionLotRate || 0);

    if (custBase === 'LOT' && custLotRate > 0 && bookedLots > 0) {
      const storedCust = Number(o.commissionAmount || 0);

      // Case A: Roll-meter decimal variance on completion (deliveredLots has fractional roll variation)
      const hasFractionalVariance = (deliveredLots % 1 !== 0) && deliveredLots > 0;

      if (isCompleted && hasFractionalVariance) {
        let expectedLots = null;

        if (deliveredLots >= bookedLots) {
          // Over-delivery: round to nearest integer lot (e.g. 12.87 -> 13 lots)
          expectedLots = Math.round(deliveredLots);
        } else {
          // Shortfall: if minor shrinkage (within 1 lot of booked), round to booked lots
          const shortfall = bookedLots - deliveredLots;
          if (shortfall <= 1.0) {
            expectedLots = bookedLots;
          }
        }

        if (expectedLots !== null) {
          const expected = expectedLots * custLotRate;
          if (storedCust > 0 && storedCust !== expected) {
            needsCustUpdate = true;
            newCustComm = expected;
          }
        }
      }

      // Case B: Creation conversion fractional discrepancy
      if (!needsCustUpdate && o.quantityUnit === 'METER' && Number(o.lotMeters || 0) > 0) {
        const rawLots = Number(o.quantity) / Number(o.lotMeters);
        if (rawLots % 1 !== 0) {
          const expected = bookedLots * custLotRate;
          const unrounded = Math.round(rawLots * custLotRate);
          if (storedCust !== expected && (storedCust === unrounded || Math.abs(storedCust - expected) <= 10)) {
            needsCustUpdate = true;
            newCustComm = expected;
          }
        }
      }
    }

    if (needsMfrUpdate || needsCustUpdate) {
      repairs.push({
        orderId: o.id,
        orderNo: o.orderNo,
        fyStartYear: o.fyStartYear,
        userEmail: o.user?.email,
        customerFirm: o.customer?.firmName || o.customer?.name,
        manufacturerFirm: o.manufacturer?.firmName || o.manufacturer?.name,
        bookedLots,
        deliveredLots: Math.round(deliveredLots * 100) / 100,
        needsMfrUpdate,
        oldMfrComm: Number(o.manufacturerCommissionAmount || 0),
        newMfrComm,
        needsCustUpdate,
        oldCustComm: Number(o.commissionAmount || 0),
        newCustComm,
        pendingPaymentId: o.pendingPayment?.id,
      });
    }
  }

  if (repairs.length === 0) {
    console.log('No orders require commission repair. All records are accurate!');
    return;
  }

  console.log(`Found ${repairs.length} orders requiring lot commission repair:`);
  console.log('-'.repeat(70));

  for (const r of repairs) {
    console.log(
      `Order #${r.orderNo} (FY ${r.fyStartYear}-${String(r.fyStartYear + 1).slice(-2)}) [${r.userEmail}]:`
    );
    if (r.needsMfrUpdate) {
      console.log(`  - Manufacturer (${r.manufacturerFirm}): ₹${r.oldMfrComm} -> ₹${r.newMfrComm} (Diff: +₹${r.newMfrComm - r.oldMfrComm})`);
    }
    if (r.needsCustUpdate) {
      console.log(`  - Customer (${r.customerFirm}): ₹${r.oldCustComm} -> ₹${r.newCustComm} (Diff: +₹${r.newCustComm - r.oldCustComm})`);
    }
  }

  console.log('-'.repeat(70));

  if (!isApply) {
    console.log('\nDRY-RUN completed. No records were modified.');
    console.log('To apply these changes to the database, run:');
    console.log('  node scripts/repair-lot-commissions.js --apply');
    if (targetUserEmail) {
      console.log(`  node scripts/repair-lot-commissions.js --apply --user=${targetUserEmail}`);
    }
    return;
  }

  console.log('\nApplying database transaction...');
  await prisma.$transaction(async (tx) => {
    for (const r of repairs) {
      const updateData = {};
      if (r.needsMfrUpdate) updateData.manufacturerCommissionAmount = r.newMfrComm;
      if (r.needsCustUpdate) updateData.commissionAmount = r.newCustComm;

      await tx.order.update({
        where: { id: r.orderId },
        data: updateData,
      });

      // If customer commission changed and order has a pendingPayment linked, update amountDue and recalibrate
      if (r.needsCustUpdate && r.pendingPaymentId) {
        await tx.pendingPayment.update({
          where: { id: r.pendingPaymentId },
          data: {
            amountDue: r.newCustComm,
          },
        });
        await syncPendingPaymentAmounts(tx, r.pendingPaymentId);
      }
    }
  });

  console.log(`SUCCESS: Successfully updated ${repairs.length} orders in database.`);
}

run()
  .catch((err) => {
    console.error('Repair failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
