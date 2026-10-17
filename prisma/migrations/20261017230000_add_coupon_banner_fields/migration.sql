-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN "showBanner" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Coupon" ADD COLUMN "bannerTheme" TEXT DEFAULT 'EMERALD';
ALTER TABLE "Coupon" ADD COLUMN "bannerHeadline" TEXT;
ALTER TABLE "Coupon" ADD COLUMN "bannerSubtitle" TEXT;
ALTER TABLE "Coupon" ADD COLUMN "bannerBadge" TEXT;

-- CreateIndex
CREATE INDEX "Coupon_showBanner_idx" ON "Coupon"("showBanner");

