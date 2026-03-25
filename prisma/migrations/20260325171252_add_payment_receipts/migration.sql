-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('CASH', 'CHEQUE', 'ONLINE', 'UPI');

-- CreateTable
CREATE TABLE "PaymentReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fyStartYear" INTEGER NOT NULL,
    "serialNo" INTEGER NOT NULL,
    "accountName" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "paymentMode" "PaymentMode" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paymentReceivedDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentReceipt_userId_idx" ON "PaymentReceipt"("userId");

-- CreateIndex
CREATE INDEX "PaymentReceipt_userId_fyStartYear_idx" ON "PaymentReceipt"("userId", "fyStartYear");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReceipt_userId_fyStartYear_serialNo_key" ON "PaymentReceipt"("userId", "fyStartYear", "serialNo");

-- AddForeignKey
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
