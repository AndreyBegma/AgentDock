-- AlterEnum
ALTER TYPE "RunKind" ADD VALUE 'ui_profile_learn';

-- AlterEnum
ALTER TYPE "UiProfileSource" ADD VALUE 'memory';

-- AlterTable
ALTER TABLE "design_settings" ADD COLUMN     "useMemory" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ui_profiles" ADD COLUMN     "learnNotes" TEXT,
ADD COLUMN     "learnedFromRevisionId" TEXT,
ADD COLUMN     "screens" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "styleRules" JSONB NOT NULL DEFAULT '[]';
