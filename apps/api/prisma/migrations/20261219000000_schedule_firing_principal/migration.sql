-- C-121 (D-10): the person a schedule firing ran as; its spend is theirs.
ALTER TABLE "schedule_firings" ADD COLUMN "principalId" TEXT;

ALTER TABLE "schedule_firings" ADD CONSTRAINT "schedule_firings_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
