-- #441: a revision holds named frames. A revision stored before keeps its one
-- mockup in design_revisions.html and reads as one frame named "Mockup"; its
-- comments sit on frame 0. No row is rewritten.

-- AlterTable
ALTER TABLE "design_comments" ADD COLUMN     "frame" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "design_revisions" ALTER COLUMN "html" DROP NOT NULL;

-- CreateTable
CREATE TABLE "design_frames" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "html" TEXT NOT NULL,

    CONSTRAINT "design_frames_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "design_frames_revisionId_position_key" ON "design_frames"("revisionId", "position");

-- AddForeignKey
ALTER TABLE "design_frames" ADD CONSTRAINT "design_frames_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "design_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
