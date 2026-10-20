-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "githubRepoId" BIGINT;

-- CreateIndex
CREATE INDEX "projects_githubRepoId_idx" ON "projects"("githubRepoId");


-- Backfill: the id of a repository an App installation already lists under
-- the project's name (spec 27 D7). The rest learn it from their next delivery.
UPDATE "projects" AS p
SET "githubRepoId" = r."repoId"
FROM (
  SELECT "fullName", MIN("repoId") AS "repoId"
  FROM "github_installation_repos"
  GROUP BY "fullName"
  HAVING COUNT(DISTINCT "repoId") = 1
) AS r
WHERE lower(p."repo") = r."fullName";
