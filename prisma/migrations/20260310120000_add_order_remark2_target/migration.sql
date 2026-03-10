-- CreateEnum
CREATE TYPE "Remark2Target" AS ENUM ('CUSTOMER', 'MANUFACTURER');

-- AlterTable
ALTER TABLE "Order"
  ADD COLUMN "remark2" TEXT,
  ADD COLUMN "remark2Target" "Remark2Target";
