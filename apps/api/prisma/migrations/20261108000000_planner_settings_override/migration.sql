-- AlterTable
ALTER TABLE "planner_settings" ADD COLUMN     "overrideInstructionsId" TEXT;

-- AddForeignKey
ALTER TABLE "planner_settings" ADD CONSTRAINT "planner_settings_overrideInstructionsId_fkey" FOREIGN KEY ("overrideInstructionsId") REFERENCES "planner_instructions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
