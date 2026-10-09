-- CreateEnum
CREATE TYPE "BaseSource" AS ENUM ('config', 'origin_head', 'gh', 'default');

-- CreateEnum
CREATE TYPE "DocsSourceKind" AS ENUM ('in_repo', 'sibling_repo', 'remote_repo', 'none');

-- CreateEnum
CREATE TYPE "DocsRule" AS ENUM ('spec_dir', 'sibling', 'same_owner_remote', 'text_link', 'back_link', 'in_repo');

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "runnerId" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "baseSource" "BaseSource" NOT NULL,
    "baseOverride" TEXT,
    "readyLabelOverride" TEXT,
    "defaultProfileId" TEXT,
    "mergeApproval" BOOLEAN NOT NULL DEFAULT false,
    "codeSentinelConfig" JSONB,
    "hasClaudeMd" BOOLEAN NOT NULL,
    "hasAgentsMd" BOOLEAN NOT NULL,
    "lastInspectedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleOverride" "Role",
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "docs_sources" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "DocsSourceKind" NOT NULL,
    "localPath" TEXT,
    "repo" TEXT,
    "isGitRepo" BOOLEAN NOT NULL,
    "detectedBy" "DocsRule",
    "evidence" JSONB NOT NULL,
    "classified" JSONB NOT NULL,
    "candidates" JSONB NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "docs_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_runnerId_rootPath_key" ON "projects"("runnerId", "rootPath");

-- CreateIndex
CREATE INDEX "project_members_userId_idx" ON "project_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_projectId_userId_key" ON "project_members"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "docs_sources_projectId_key" ON "docs_sources"("projectId");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "runners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_defaultProfileId_fkey" FOREIGN KEY ("defaultProfileId") REFERENCES "runtime_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "docs_sources" ADD CONSTRAINT "docs_sources_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
