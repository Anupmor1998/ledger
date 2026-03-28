/*
  Warnings:

  - You are about to drop the column `pendingPaymentId` on the `PaymentReceipt` table. All the data in the column will be lost.

*/
-- AlterEnum
ALTER TYPE "PendingPaymentStatus" ADD VALUE 'SETTLED';

-- DropForeignKey
ALTER TABLE "PaymentReceipt" DROP CONSTRAINT "PaymentReceipt_pendingPaymentId_fkey";

-- DropIndex
DROP INDEX "PaymentReceipt_pendingPaymentId_idx";

-- AlterTable
ALTER TABLE "PaymentReceipt" DROP COLUMN "pendingPaymentId";

-- AlterTable
ALTER TABLE "PendingPayment" ADD COLUMN     "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "finalSettledAmount" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paymentReceiptId" TEXT NOT NULL,
    "pendingPaymentId" TEXT NOT NULL,
    "allocatedAmount" DECIMAL(12,2) NOT NULL,
    "isFinalSettlement" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentAllocation_userId_idx" ON "PaymentAllocation"("userId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_paymentReceiptId_idx" ON "PaymentAllocation"("paymentReceiptId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_pendingPaymentId_idx" ON "PaymentAllocation"("pendingPaymentId");

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentReceiptId_fkey" FOREIGN KEY ("paymentReceiptId") REFERENCES "PaymentReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_pendingPaymentId_fkey" FOREIGN KEY ("pendingPaymentId") REFERENCES "PendingPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
