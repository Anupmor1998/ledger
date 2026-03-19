ALTER TABLE "Order"
ADD COLUMN "customerRemark" TEXT,
ADD COLUMN "manufacturerRemark" TEXT;

UPDATE "Order"
SET
  "customerRemark" = CASE
    WHEN "remark2Target" = 'CUSTOMER' THEN "remark2"
    ELSE "customerRemark"
  END,
  "manufacturerRemark" = CASE
    WHEN "remark2Target" = 'MANUFACTURER' THEN "remark2"
    ELSE "manufacturerRemark"
  END;

ALTER TABLE "Order"
DROP COLUMN IF EXISTS "remark2",
DROP COLUMN IF EXISTS "remark2Target";

DROP TYPE IF EXISTS "Remark2Target";
