CREATE TYPE "QuantityUnit" AS ENUM ('TAKKA', 'LOT');

ALTER TABLE "Order"
ADD COLUMN "quantityUnit" "QuantityUnit" NOT NULL DEFAULT 'TAKKA',
ADD COLUMN "lotMeters" DECIMAL(12,2),
ADD COLUMN "meter" DECIMAL(12,2),
ADD COLUMN "commissionAmount" DECIMAL(12,2);
