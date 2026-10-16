-- #482: a refused `finish_card` of a round, from `card_run.finish_refused`.
ALTER TABLE "board_card_rounds" ADD COLUMN "finishRefusedCode" TEXT,
ADD COLUMN "finishRefusedAt" TIMESTAMP(3);
