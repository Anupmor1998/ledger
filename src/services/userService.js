const prisma = require("../config/prisma");
const AppError = require("../utils/appError");

/**
 * Permanently deletes a user account and all associated relational data
 * in strict foreign-key dependency order within a transaction.
 */
async function deleteUserAccount(userId, db = prisma) {
  if (!userId) {
    throw new AppError("userId is required for account deletion", 400);
  }

  return db.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, firmName: true, role: true },
    });

    if (!existing) {
      throw new AppError("User not found", 404);
    }

    // 1. Break self-referencing foreign keys on Order & PendingPayment
    await tx.order.updateMany({
      where: { userId },
      data: { carriedForwardFromOrderId: null },
    });

    await tx.pendingPayment.updateMany({
      where: { userId },
      data: { carriedForwardFromPendingPaymentId: null },
    });

    // 2. Delete payment allocations (depend on pendingPayment, paymentReceipt, order, paymentEntry)
    await tx.paymentAllocation.deleteMany({
      where: { userId },
    });

    await tx.paymentOrderAllocation.deleteMany({
      where: { userId },
    });

    // 3. Delete order activities
    await tx.orderActivity.deleteMany({
      where: { userId },
    });

    // 4. Delete pending payments
    await tx.pendingPayment.deleteMany({
      where: { userId },
    });

    // 5. Delete orders
    await tx.order.deleteMany({
      where: { userId },
    });

    // 6. Delete payment receipts and payment entries
    await tx.paymentReceipt.deleteMany({
      where: { userId },
    });

    await tx.paymentEntry.deleteMany({
      where: { userId },
    });

    // 7. Delete year transfer batches
    await tx.yearTransferBatch.deleteMany({
      where: { userId },
    });

    // 8. Delete customer qualities & manufacturer qualities
    await tx.customerQuality.deleteMany({
      where: { userId },
    });

    await tx.manufacturerQuality.deleteMany({
      where: { userId },
    });

    // 9. Delete customers, manufacturers, qualities
    await tx.customer.deleteMany({
      where: { userId },
    });

    await tx.manufacturer.deleteMany({
      where: { userId },
    });

    await tx.quality.deleteMany({
      where: { userId },
    });

    // 10. Update support tickets resolved by this user (if admin) & delete tickets created by this user
    await tx.supportTicket.updateMany({
      where: { resolvedByAdminId: userId },
      data: { resolvedByAdminId: null },
    });

    await tx.supportTicket.deleteMany({
      where: { userId },
    });

    // 11. Update coupons created by this user
    await tx.coupon.updateMany({
      where: { createdById: userId },
      data: { createdById: null },
    });

    // 12. Delete admin action logs where this user is the actor
    await tx.adminActionLog.deleteMany({
      where: { userId },
    });

    // 13. Delete remaining direct cascade relations
    await tx.passwordResetToken.deleteMany({
      where: { userId },
    });

    await tx.whatsAppGroup.deleteMany({
      where: { userId },
    });

    await tx.remarkTemplate.deleteMany({
      where: { userId },
    });

    await tx.reportShare.deleteMany({
      where: { userId },
    });

    await tx.subscriptionPayment.deleteMany({
      where: { userId },
    });

    // 14. Finally delete the user record
    await tx.user.delete({
      where: { id: userId },
    });

    return existing;
  });
}

module.exports = {
  deleteUserAccount,
};

