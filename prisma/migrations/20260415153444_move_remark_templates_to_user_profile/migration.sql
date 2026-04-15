/*
  Warnings:

  - You are about to drop the column `remark` on the `Customer` table. All the data in the column will be lost.
  - You are about to drop the column `remark` on the `Manufacturer` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Customer" DROP COLUMN "remark";

-- AlterTable
ALTER TABLE "Manufacturer" DROP COLUMN "remark";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "customerRemarkTemplate" TEXT,
ADD COLUMN     "manufacturerRemarkTemplate" TEXT;
