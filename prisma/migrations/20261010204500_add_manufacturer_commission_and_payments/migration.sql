-- AlterTable Manufacturer
ALTER TABLE "Manufacturer" ADD COLUMN IF NOT EXISTS "commissionBase" "CommissionBase" NOT NULL DEFAULT 'LOT';
ALTER TABLE "Manufacturer" ADD COLUMN IF NOT EXISTS "commissionPercent" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "Manufacturer" ADD COLUMN IF NOT EXISTS "commissionLotRate" DECIMAL(12,2) DEFAULT 0;

-- AlterTable Order
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "manufacturerCommissionAmount" DECIMAL(12,2) DEFAULT 0;

-- AlterTable PaymentEntry
ALTER TABLE "PaymentEntry" ADD COLUMN IF NOT EXISTS "partyType" TEXT NOT NULL DEFAULT 'CUSTOMER';
ALTER TABLE "PaymentEntry" ALTER COLUMN "customerId" DROP NOT NULL;
ALTER TABLE "PaymentEntry" ADD COLUMN IF NOT EXISTS "manufacturerId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentEntry_manufacturerId_idx" ON "PaymentEntry"("manufacturerId");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'PaymentEntry_manufacturerId_fkey'
    ) THEN
        ALTER TABLE "PaymentEntry" ADD CONSTRAINT "PaymentEntry_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

