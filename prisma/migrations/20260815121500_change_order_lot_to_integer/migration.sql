-- Convert order lot from decimal to integer
ALTER TABLE "Order"
ALTER COLUMN "lot" TYPE INTEGER
USING ROUND("lot")::INTEGER;
