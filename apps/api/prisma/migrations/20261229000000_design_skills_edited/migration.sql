-- #604: a design follows the project's default skills until they are edited
-- by hand. An existing design whose skills differ from its project's default
-- was edited (or the default changed since) and keeps its own set.
ALTER TABLE "task_designs" ADD COLUMN "skillsEdited" BOOLEAN NOT NULL DEFAULT false;

UPDATE "task_designs" AS d
SET "skillsEdited" = true
WHERE d."skills" IS DISTINCT FROM COALESCE(
  (
    SELECT s."defaultSkills"
    FROM "design_settings" AS s
    WHERE s."projectId" = COALESCE(
      (SELECT p."projectId" FROM "plans" AS p WHERE p."id" = d."planId"),
      (SELECT c."projectId" FROM "board_cards" AS c WHERE c."id" = d."cardId"),
      (SELECT b."projectId" FROM "board_stacks" AS b WHERE b."id" = d."stackId")
    )
  ),
  ARRAY[]::TEXT[]
);
