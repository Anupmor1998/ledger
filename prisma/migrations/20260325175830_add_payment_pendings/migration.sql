-- CreateEnum
CREATE TYPE "PendingPaymentStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID');

-- AlterTable
ALTER TABLE "PaymentReceipt" ADD COLUMN     "pendingPaymentId" TEXT;

-- CreateTable
CREATE TABLE "PendingPayment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fyStartYear" INTEGER NOT NULL,
    "serialNo" INTEGER NOT NULL,
    "accountName" TEXT NOT NULL,
    "amountDue" DECIMAL(12,2) NOT NULL,
    "amountReceived" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "balanceAmount" DECIMAL(12,2) NOT NULL,
    "status" "PendingPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "dueDate" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingPayment_orderId_key" ON "PendingPayment"("orderId");

-- CreateIndex
CREATE INDEX "PendingPayment_userId_idx" ON "PendingPayment"("userId");

-- CreateIndex
CREATE INDEX "PendingPayment_userId_fyStartYear_idx" ON "PendingPayment"("userId", "fyStartYear");

-- CreateIndex
CREATE INDEX "PendingPayment_status_idx" ON "PendingPayment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PendingPayment_userId_fyStartYear_serialNo_key" ON "PendingPayment"("userId", "fyStartYear", "serialNo");

-- CreateIndex
CREATE INDEX "PaymentReceipt_pendingPaymentId_idx" ON "PaymentReceipt"("pendingPaymentId");

-- AddForeignKey
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_pendingPaymentId_fkey" FOREIGN KEY ("pendingPaymentId") REFERENCES "PendingPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingPayment" ADD CONSTRAINT "PendingPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingPayment" ADD CONSTRAINT "PendingPayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
