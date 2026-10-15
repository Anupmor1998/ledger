-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Coupon_isPublic_idx" ON "Coupon"("isPublic");

