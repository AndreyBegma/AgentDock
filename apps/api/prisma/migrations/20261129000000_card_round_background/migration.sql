-- #390 (ADR-0038): a round whose turn stopped with its own background tasks running.
ALTER TYPE "CardRoundPhase" ADD VALUE 'background' AFTER 'waiting';

ALTER TABLE "board_card_rounds"
  ADD COLUMN "backgroundAt" TIMESTAMP(3),
  ADD COLUMN "backgroundTasks" INTEGER,
  ADD COLUMN "backgroundCommand" TEXT,
  ADD COLUMN "backgroundStalledAt" TIMESTAMP(3);

ALTER TABLE "board_settings"
  ADD COLUMN "backgroundStallMinutes" INTEGER NOT NULL DEFAULT 30;
