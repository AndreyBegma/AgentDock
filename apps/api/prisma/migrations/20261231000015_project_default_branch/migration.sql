-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "defaultBranch" TEXT;

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "protectedPaths" TEXT[] DEFAULT ARRAY[]::TEXT[];


-- Backfill (C-148): a base read from `origin/HEAD` or `gh` is the default
-- branch. A configured or guessed base says nothing about it, so those stay
-- unknown — and auto-merge off — until the next inspection reports it.
UPDATE "projects"
SET "defaultBranch" = "baseBranch"
WHERE "baseSource" IN ('origin_head', 'gh');
