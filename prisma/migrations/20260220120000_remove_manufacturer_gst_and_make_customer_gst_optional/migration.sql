-- Customer GST should be optional
ALTER TABLE "Customer"
ALTER COLUMN "gstNo" DROP NOT NULL;

-- Manufacturer GST is no longer tracked
ALTER TABLE "Manufacturer"
DROP COLUMN "gstNo";

-- Add ownership columns for per-user data isolation
ALTER TABLE "Customer" ADD COLUMN "userId" TEXT;
ALTER TABLE "Manufacturer" ADD COLUMN "userId" TEXT;
ALTER TABLE "Quality" ADD COLUMN "userId" TEXT;

-- Backfill ownership from existing orders where possible
UPDATE "Customer" c
SET "userId" = o."userId"
FROM "Order" o
WHERE o."customerId" = c."id"
  AND c."userId" IS NULL;

UPDATE "Manufacturer" m
SET "userId" = o."userId"
FROM "Order" o
WHERE o."manufacturerId" = m."id"
  AND m."userId" IS NULL;

UPDATE "Quality" q
SET "userId" = o."userId"
FROM "Order" o
WHERE o."qualityId" = q."id"
  AND q."userId" IS NULL;

-- Fallback assignment for records without order history
UPDATE "Customer"
SET "userId" = (SELECT "id" FROM "User" ORDER BY "createdAt" ASC LIMIT 1)
WHERE "userId" IS NULL;

UPDATE "Manufacturer"
SET "userId" = (SELECT "id" FROM "User" ORDER BY "createdAt" ASC LIMIT 1)
WHERE "userId" IS NULL;

UPDATE "Quality"
SET "userId" = (SELECT "id" FROM "User" ORDER BY "createdAt" ASC LIMIT 1)
WHERE "userId" IS NULL;

-- Ownership is required moving forward
ALTER TABLE "Customer" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "Manufacturer" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "Quality" ALTER COLUMN "userId" SET NOT NULL;

-- Replace global unique indexes with per-user unique indexes
DROP INDEX IF EXISTS "Customer_gstNo_key";
DROP INDEX IF EXISTS "Customer_phone_key";
DROP INDEX IF EXISTS "Manufacturer_phone_key";
DROP INDEX IF EXISTS "Quality_name_key";

CREATE UNIQUE INDEX "Customer_userId_gstNo_key" ON "Customer"("userId", "gstNo");
CREATE UNIQUE INDEX "Customer_userId_phone_key" ON "Customer"("userId", "phone");
CREATE UNIQUE INDEX "Manufacturer_userId_phone_key" ON "Manufacturer"("userId", "phone");
CREATE UNIQUE INDEX "Quality_userId_name_key" ON "Quality"("userId", "name");

-- Add userId lookup indexes
CREATE INDEX "Customer_userId_idx" ON "Customer"("userId");
CREATE INDEX "Manufacturer_userId_idx" ON "Manufacturer"("userId");
CREATE INDEX "Quality_userId_idx" ON "Quality"("userId");

-- Add ownership foreign keys
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Manufacturer" ADD CONSTRAINT "Manufacturer_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Quality" ADD CONSTRAINT "Quality_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
