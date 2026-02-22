-- Customer: add required firmName (backfilled from existing name)
ALTER TABLE "Customer" ADD COLUMN "firmName" TEXT;
UPDATE "Customer" SET "firmName" = COALESCE("firmName", "name");
ALTER TABLE "Customer" ALTER COLUMN "firmName" SET NOT NULL;

-- Manufacturer: add optional firmName and make address optional
ALTER TABLE "Manufacturer" ADD COLUMN "firmName" TEXT;
ALTER TABLE "Manufacturer" ALTER COLUMN "address" DROP NOT NULL;