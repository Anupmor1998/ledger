/*
  Warnings:

  - You are about to drop the column `customerRemarkTemplate` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `manufacturerRemarkTemplate` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "User" DROP COLUMN "customerRemarkTemplate",
DROP COLUMN "manufacturerRemarkTemplate",
ADD COLUMN     "generalRemarkTemplate" TEXT;
