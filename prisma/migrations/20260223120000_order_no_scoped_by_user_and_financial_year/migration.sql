-- Add FY start year for each order
ALTER TABLE "Order"
ADD COLUMN "fyStartYear" INTEGER;

-- Backfill FY in IST (Apr-Mar)
UPDATE "Order"
SET "fyStartYear" = CASE
  WHEN EXTRACT(MONTH FROM ("orderDate" AT TIME ZONE 'Asia/Kolkata')) >= 4
    THEN EXTRACT(YEAR FROM ("orderDate" AT TIME ZONE 'Asia/Kolkata'))::INTEGER
  ELSE (EXTRACT(YEAR FROM ("orderDate" AT TIME ZONE 'Asia/Kolkata'))::INTEGER - 1)
END;

ALTER TABLE "Order"
ALTER COLUMN "fyStartYear" SET NOT NULL;

-- Replace current user-scoped uniqueness with user+FY scoped uniqueness
DROP INDEX IF EXISTS "Order_userId_orderNo_key";
DROP INDEX IF EXISTS "Order_orderNo_key";

CREATE INDEX "Order_userId_fyStartYear_idx" ON "Order"("userId", "fyStartYear");
CREATE UNIQUE INDEX "Order_userId_fyStartYear_orderNo_key" ON "Order"("userId", "fyStartYear", "orderNo");
