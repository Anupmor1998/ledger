CREATE TABLE "WhatsAppGroup" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "inviteLink" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsAppGroup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WhatsAppGroup_userId_idx" ON "WhatsAppGroup"("userId");
CREATE UNIQUE INDEX "WhatsAppGroup_userId_name_key" ON "WhatsAppGroup"("userId", "name");

ALTER TABLE "WhatsAppGroup"
ADD CONSTRAINT "WhatsAppGroup_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
