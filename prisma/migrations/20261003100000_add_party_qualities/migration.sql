-- CreateTable
CREATE TABLE "CustomerQuality" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "qualityId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerQuality_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManufacturerQuality" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "manufacturerId" TEXT NOT NULL,
    "qualityId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManufacturerQuality_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerQuality_userId_idx" ON "CustomerQuality"("userId");
CREATE INDEX "CustomerQuality_customerId_idx" ON "CustomerQuality"("customerId");
CREATE INDEX "CustomerQuality_qualityId_idx" ON "CustomerQuality"("qualityId");
CREATE UNIQUE INDEX "CustomerQuality_userId_customerId_qualityId_key" ON "CustomerQuality"("userId", "customerId", "qualityId");

-- CreateIndex
CREATE INDEX "ManufacturerQuality_userId_idx" ON "ManufacturerQuality"("userId");
CREATE INDEX "ManufacturerQuality_manufacturerId_idx" ON "ManufacturerQuality"("manufacturerId");
CREATE INDEX "ManufacturerQuality_qualityId_idx" ON "ManufacturerQuality"("qualityId");
CREATE UNIQUE INDEX "ManufacturerQuality_userId_manufacturerId_qualityId_key" ON "ManufacturerQuality"("userId", "manufacturerId", "qualityId");

-- AddForeignKey
ALTER TABLE "CustomerQuality" ADD CONSTRAINT "CustomerQuality_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerQuality" ADD CONSTRAINT "CustomerQuality_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerQuality" ADD CONSTRAINT "CustomerQuality_qualityId_fkey" FOREIGN KEY ("qualityId") REFERENCES "Quality"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManufacturerQuality" ADD CONSTRAINT "ManufacturerQuality_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManufacturerQuality" ADD CONSTRAINT "ManufacturerQuality_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManufacturerQuality" ADD CONSTRAINT "ManufacturerQuality_qualityId_fkey" FOREIGN KEY ("qualityId") REFERENCES "Quality"("id") ON DELETE CASCADE ON UPDATE CASCADE;

