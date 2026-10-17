-- AlterEnum
ALTER TYPE "PlanMode" ADD VALUE 'discuss';

-- AlterEnum
ALTER TYPE "PlanTurnAction" ADD VALUE 'discuss';

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "skills" TEXT[] DEFAULT ARRAY[]::TEXT[];
