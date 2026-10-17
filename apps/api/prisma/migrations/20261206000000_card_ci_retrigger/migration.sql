-- #484: a card PR head that CI never reported on is retriggered once.
ALTER TABLE "board_cards" ADD COLUMN     "ciNoneSince" TIMESTAMP(3),
ADD COLUMN     "ciRetriggeredSha" TEXT;
