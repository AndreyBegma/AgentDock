-- #624: the Claude Code dialog that blocks a waiting round, from `card_run.dialog`.
ALTER TABLE "board_card_rounds" ADD COLUMN "blockingDialog" TEXT;
