-- Design stage (docs/specs/223-design-stage.md "Data / Schema", ADR-0022).

-- CreateEnum
CREATE TYPE "UiProfileSource" AS ENUM ('agent', 'manual');

-- CreateEnum
CREATE TYPE "TaskDesignStatus" AS ENUM ('idle', 'generating', 'reviewing', 'revising', 'approved');

-- CreateEnum
CREATE TYPE "DesignCommentKind" AS ENUM ('general', 'screen', 'pin');

-- CreateEnum
CREATE TYPE "DesignTheme" AS ENUM ('light', 'dark');

-- AlterEnum
ALTER TYPE "PlanTaskStatus" ADD VALUE 'needs_design';

-- AlterEnum
ALTER TYPE "PlanTurnAction" ADD VALUE 'design';

-- AlterEnum
ALTER TYPE "RunKind" ADD VALUE 'ui_profile';

-- CreateTable
CREATE TABLE "ui_profiles" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source" "UiProfileSource" NOT NULL,
    "hasUi" BOOLEAN NOT NULL,
    "summary" TEXT NOT NULL,
    "kit" TEXT NOT NULL,
    "snippets" JSONB NOT NULL DEFAULT '[]',
    "fingerprintGlobs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fingerprint" TEXT NOT NULL,
    "obligations" TEXT,
    "runId" TEXT,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ui_profiles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ui_profiles_version_check" CHECK ("version" >= 1)
);

-- CreateTable
CREATE TABLE "design_settings" (
    "projectId" TEXT NOT NULL,
    "viewports" JSONB NOT NULL,
    "defaultSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "design_settings_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "task_designs" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "needed" BOOLEAN NOT NULL,
    "suggested" BOOLEAN NOT NULL DEFAULT false,
    "suggestionWhy" TEXT,
    "variantCount" INTEGER NOT NULL DEFAULT 1,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "profileId" TEXT,
    "status" "TaskDesignStatus" NOT NULL DEFAULT 'idle',
    "approvedRevisionId" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_designs_pkey" PRIMARY KEY ("id"),
    -- Spec 223 D4: 1–3 variants.
    CONSTRAINT "task_designs_variant_count_check" CHECK ("variantCount" BETWEEN 1 AND 3)
);

-- CreateTable
CREATE TABLE "design_revisions" (
    "id" TEXT NOT NULL,
    "designId" TEXT NOT NULL,
    "variant" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "design_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "design_revisions_variant_check" CHECK ("variant" BETWEEN 1 AND 3),
    CONSTRAINT "design_revisions_revision_check" CHECK ("revision" >= 1)
);

-- CreateTable
CREATE TABLE "design_comments" (
    "id" TEXT NOT NULL,
    "designId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "authorId" TEXT,
    "kind" "DesignCommentKind" NOT NULL,
    "viewport" TEXT,
    "theme" "DesignTheme",
    "x" DOUBLE PRECISION,
    "y" DOUBLE PRECISION,
    "selector" TEXT,
    "body" TEXT NOT NULL,
    "addressedInRevisionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "design_comments_pkey" PRIMARY KEY ("id"),
    -- Spec 223 D9: a pin carries its point.
    CONSTRAINT "design_comments_pin_check" CHECK (
        "kind" <> 'pin' OR ("x" IS NOT NULL AND "y" IS NOT NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "ui_profiles_projectId_version_key" ON "ui_profiles"("projectId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "task_designs_approvedRevisionId_key" ON "task_designs"("approvedRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "task_designs_planId_taskKey_key" ON "task_designs"("planId", "taskKey");

-- CreateIndex
CREATE INDEX "design_revisions_turnId_idx" ON "design_revisions"("turnId");

-- CreateIndex
CREATE UNIQUE INDEX "design_revisions_designId_variant_revision_key" ON "design_revisions"("designId", "variant", "revision");

-- CreateIndex
CREATE INDEX "design_comments_designId_createdAt_idx" ON "design_comments"("designId", "createdAt");

-- CreateIndex
CREATE INDEX "design_comments_revisionId_idx" ON "design_comments"("revisionId");

-- AddForeignKey
ALTER TABLE "ui_profiles" ADD CONSTRAINT "ui_profiles_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ui_profiles" ADD CONSTRAINT "ui_profiles_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ui_profiles" ADD CONSTRAINT "ui_profiles_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_settings" ADD CONSTRAINT "design_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_settings" ADD CONSTRAINT "design_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_designs" ADD CONSTRAINT "task_designs_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_designs" ADD CONSTRAINT "task_designs_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ui_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_designs" ADD CONSTRAINT "task_designs_approvedRevisionId_fkey" FOREIGN KEY ("approvedRevisionId") REFERENCES "design_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_designs" ADD CONSTRAINT "task_designs_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_revisions" ADD CONSTRAINT "design_revisions_designId_fkey" FOREIGN KEY ("designId") REFERENCES "task_designs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_revisions" ADD CONSTRAINT "design_revisions_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "plan_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_comments" ADD CONSTRAINT "design_comments_designId_fkey" FOREIGN KEY ("designId") REFERENCES "task_designs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_comments" ADD CONSTRAINT "design_comments_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "design_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_comments" ADD CONSTRAINT "design_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_comments" ADD CONSTRAINT "design_comments_addressedInRevisionId_fkey" FOREIGN KEY ("addressedInRevisionId") REFERENCES "design_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
