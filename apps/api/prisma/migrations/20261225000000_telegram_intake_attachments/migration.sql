-- #594: photos sent to `/new` before its description, claimed by the plan it starts.
ALTER TABLE "telegram_intakes" ADD COLUMN "attachmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
