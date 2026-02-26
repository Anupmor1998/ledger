ALTER TABLE "Order"
  ALTER COLUMN "processedQuantity" TYPE DECIMAL(12, 2)
  USING "processedQuantity"::DECIMAL(12, 2),
  ALTER COLUMN "processedQuantity" SET DEFAULT 0;

ALTER TABLE "Order"
  ADD COLUMN "processedMeter" DECIMAL(12, 2) NOT NULL DEFAULT 0;
