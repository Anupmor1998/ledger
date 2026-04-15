/*
  Warnings:

  - You are about to drop the column `generalRemarkTemplate` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "User" DROP COLUMN "generalRemarkTemplate";

-- CreateTable
CREATE TABLE "RemarkTemplate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemarkTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RemarkTemplate_userId_idx" ON "RemarkTemplate"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RemarkTemplate_userId_text_key" ON "RemarkTemplate"("userId", "text");

-- AddForeignKey
ALTER TABLE "RemarkTemplate" ADD CONSTRAINT "RemarkTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
