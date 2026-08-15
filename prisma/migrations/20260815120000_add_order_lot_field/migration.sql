-- Add stored lot value for reporting
ALTER TABLE "Order"
ADD COLUMN "lot" DECIMAL(12,2);
