-- AlterTable
ALTER TABLE "github_deliveries" ADD COLUMN     "bodySha256" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "github_deliveries_bodySha256_key" ON "github_deliveries"("bodySha256");
