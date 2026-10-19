-- CreateTable
CREATE TABLE IF NOT EXISTS "ReportShare" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ReportShare_code_key" ON "ReportShare"("code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ReportShare_code_idx" ON "ReportShare"("code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ReportShare_userId_idx" ON "ReportShare"("userId");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "ReportShare" ADD CONSTRAINT "ReportShare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

