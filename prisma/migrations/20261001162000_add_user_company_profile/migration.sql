-- AlterTable: Add business profile fields to User table
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "firmName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "businessSubtitle" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "contactPhone" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "businessAddress" TEXT;

-- Pre-populate existing user accounts with Moolchand business profile
UPDATE "User"
SET
  "firmName" = 'Moolchand H Vadera',
  "businessSubtitle" = 'Grey Broker & Commission Agent',
  "contactPhone" = '9374565779, 7016605692',
  "businessAddress" = 'D-601 SONAL RESIDENCY, OPP RESHMA ROW HOUSE, PUNA PATIYA, SURAT-395010'
WHERE "firmName" IS NULL;
