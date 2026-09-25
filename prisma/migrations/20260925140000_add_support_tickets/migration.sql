-- CreateEnum safely
DO $$ BEGIN
    CREATE TYPE "TicketCategory" AS ENUM ('BILLING_PAYMENT', 'ORDER_ISSUE', 'TECHNICAL_GLITCH', 'ACCOUNT_PROFILE', 'OTHER');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "SupportTicket" (
    "id" TEXT NOT NULL,
    "ticketNo" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "category" "TicketCategory" NOT NULL DEFAULT 'OTHER',
    "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "description" TEXT NOT NULL,
    "contactPhone" TEXT,
    "contactPreference" TEXT NOT NULL DEFAULT 'WHATSAPP',
    "adminNotes" TEXT,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupportTicket_userId_idx" ON "SupportTicket"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupportTicket_status_idx" ON "SupportTicket"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupportTicket_category_idx" ON "SupportTicket"("category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupportTicket_priority_idx" ON "SupportTicket"("priority");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupportTicket_createdAt_idx" ON "SupportTicket"("createdAt");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_resolvedByAdminId_fkey" FOREIGN KEY ("resolvedByAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;