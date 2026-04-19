-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "carriedForwardFromOrderId" TEXT,
ADD COLUMN     "isCarryForward" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transferBatchId" TEXT;

-- AlterTable
ALTER TABLE "PendingPayment" ADD COLUMN     "carriedForwardFromPendingPaymentId" TEXT,
ADD COLUMN     "isCarryForward" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transferBatchId" TEXT;

-- CreateTable
CREATE TABLE "YearTransferBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceFyStartYear" INTEGER NOT NULL,
    "targetFyStartYear" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YearTransferBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "YearTransferBatch_userId_idx" ON "YearTransferBatch"("userId");

-- CreateIndex
CREATE INDEX "YearTransferBatch_userId_sourceFyStartYear_idx" ON "YearTransferBatch"("userId", "sourceFyStartYear");

-- CreateIndex
CREATE INDEX "YearTransferBatch_userId_targetFyStartYear_idx" ON "YearTransferBatch"("userId", "targetFyStartYear");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_carriedForwardFromOrderId_fkey" FOREIGN KEY ("carriedForwardFromOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_transferBatchId_fkey" FOREIGN KEY ("transferBatchId") REFERENCES "YearTransferBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingPayment" ADD CONSTRAINT "PendingPayment_carriedForwardFromPendingPaymentId_fkey" FOREIGN KEY ("carriedForwardFromPendingPaymentId") REFERENCES "PendingPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingPayment" ADD CONSTRAINT "PendingPayment_transferBatchId_fkey" FOREIGN KEY ("transferBatchId") REFERENCES "YearTransferBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YearTransferBatch" ADD CONSTRAINT "YearTransferBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
