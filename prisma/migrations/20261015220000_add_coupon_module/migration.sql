-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CouponDiscountType') THEN
    CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENTAGE', 'FLAT');
  END IF;
END$$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Coupon" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "description" TEXT,
  "discountType" "CouponDiscountType" NOT NULL DEFAULT 'PERCENTAGE',
  "discountValue" DOUBLE PRECISION NOT NULL,
  "minOrderAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "maxDiscount" DOUBLE PRECISION,
  "maxUses" INTEGER,
  "usedCount" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Coupon_code_key" ON "Coupon"("code");
CREATE INDEX IF NOT EXISTS "Coupon_code_idx" ON "Coupon"("code");
CREATE INDEX IF NOT EXISTS "Coupon_isActive_idx" ON "Coupon"("isActive");
CREATE INDEX IF NOT EXISTS "Coupon_expiresAt_idx" ON "Coupon"("expiresAt");

-- AlterTable SubscriptionPayment
ALTER TABLE "SubscriptionPayment" ADD COLUMN IF NOT EXISTS "couponId" TEXT;
ALTER TABLE "SubscriptionPayment" ADD COLUMN IF NOT EXISTS "couponCode" TEXT;
ALTER TABLE "SubscriptionPayment" ADD COLUMN IF NOT EXISTS "discountAmount" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SubscriptionPayment_couponId_idx" ON "SubscriptionPayment"("couponId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SubscriptionPayment_couponId_fkey'
  ) THEN
    ALTER TABLE "SubscriptionPayment"
      ADD CONSTRAINT "SubscriptionPayment_couponId_fkey"
      FOREIGN KEY ("couponId") REFERENCES "Coupon"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

