-- CreateTable
CREATE TABLE IF NOT EXISTS "WhatsAppTemplate" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "badge" TEXT DEFAULT 'Custom',
    "text" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WhatsAppTemplate_createdAt_idx" ON "WhatsAppTemplate"("createdAt");
