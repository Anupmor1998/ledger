-- CreateEnum
CREATE TYPE "PaymentAdjustmentType" AS ENUM ('ORDER_ID', 'PARTIAL');

-- CreateTable
CREATE TABLE
    "PaymentEntry" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "fyStartYear" INTEGER NOT NULL,
        "serialNo" INTEGER NOT NULL,
        "customerId" TEXT NOT NULL,
        "date" TIMESTAMP(3) NOT NULL,
        "paymentMode" "PaymentMode" NOT NULL,
        "remark" TEXT,
        "amount" DECIMAL(12, 2) NOT NULL,
        "adjustedAgainst" "PaymentAdjustmentType" NOT NULL DEFAULT 'ORDER_ID',
        "orderDateFrom" TIMESTAMP(3),
        "orderDateTo" TIMESTAMP(3),
        "isFullySettled" BOOLEAN NOT NULL DEFAULT false,
        "finalSettledAmount" DECIMAL(12, 2),
        "settledAt" TIMESTAMP(3),
        "isCarryForward" BOOLEAN NOT NULL DEFAULT false,
        "carriedForwardFromPaymentEntryId" TEXT,
        "transferBatchId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "PaymentEntry_pkey" PRIMARY KEY ("id")
    );

-- CreateTable
CREATE TABLE
    "PaymentOrderAllocation" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "paymentEntryId" TEXT NOT NULL,
        "orderId" TEXT NOT NULL,
        "allocatedAmount" DECIMAL(12, 2) NOT NULL,
        "isSettled" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "PaymentOrderAllocation_pkey" PRIMARY KEY ("id")
    );

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEntry_userId_fyStartYear_serialNo_key" ON "PaymentEntry" ("userId", "fyStartYear", "serialNo");

-- CreateIndex
CREATE INDEX "PaymentEntry_userId_idx" ON "PaymentEntry" ("userId");

-- CreateIndex
CREATE INDEX "PaymentEntry_userId_fyStartYear_idx" ON "PaymentEntry" ("userId", "fyStartYear");

-- CreateIndex
CREATE INDEX "PaymentEntry_customerId_idx" ON "PaymentEntry" ("customerId");

-- CreateIndex
CREATE INDEX "PaymentOrderAllocation_userId_idx" ON "PaymentOrderAllocation" ("userId");

-- CreateIndex
CREATE INDEX "PaymentOrderAllocation_paymentEntryId_idx" ON "PaymentOrderAllocation" ("paymentEntryId");

-- CreateIndex
CREATE INDEX "PaymentOrderAllocation_orderId_idx" ON "PaymentOrderAllocation" ("orderId");

-- AddForeignKey
ALTER TABLE "PaymentEntry" ADD CONSTRAINT "PaymentEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentEntry" ADD CONSTRAINT "PaymentEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentEntry" ADD CONSTRAINT "PaymentEntry_carriedForwardFromPaymentEntryId_fkey" FOREIGN KEY ("carriedForwardFromPaymentEntryId") REFERENCES "PaymentEntry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentEntry" ADD CONSTRAINT "PaymentEntry_transferBatchId_fkey" FOREIGN KEY ("transferBatchId") REFERENCES "YearTransferBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOrderAllocation" ADD CONSTRAINT "PaymentOrderAllocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOrderAllocation" ADD CONSTRAINT "PaymentOrderAllocation_paymentEntryId_fkey" FOREIGN KEY ("paymentEntryId") REFERENCES "PaymentEntry" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOrderAllocation" ADD CONSTRAINT "PaymentOrderAllocation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;