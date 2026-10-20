-- #719: profile keys a person hid from AgentDock on a runner.
ALTER TABLE "runners" ADD COLUMN "ignoredProfileKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];
