DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CommissionBase') THEN
    CREATE TYPE "CommissionBase" AS ENUM ('PERCENT', 'LOT');
  END IF;
END $$;

ALTER TABLE "Customer"
ADD COLUMN "commissionBase" "CommissionBase" NOT NULL DEFAULT 'PERCENT',
ADD COLUMN "commissionPercent" DECIMAL(5,2) NOT NULL DEFAULT 1,
ADD COLUMN "commissionLotRate" DECIMAL(12,2);