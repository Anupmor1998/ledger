-- Add per-user order sequence counter
ALTER TABLE "User"
ADD COLUMN "orderCounter" INTEGER NOT NULL DEFAULT 0;

-- Backfill counter from existing data so next order number continues correctly per user
UPDATE "User" AS u
SET "orderCounter" = source.max_order_no
FROM (
  SELECT "userId", COALESCE(MAX("orderNo"), 0) AS max_order_no
  FROM "Order"
  GROUP BY "userId"
) AS source
WHERE u."id" = source."userId";

-- Replace global order number uniqueness with per-user uniqueness
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_orderNo_key";

CREATE UNIQUE INDEX "Order_userId_orderNo_key" ON "Order"("userId", "orderNo");
