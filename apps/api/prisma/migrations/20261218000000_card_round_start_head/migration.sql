-- #542: the PR head a card round started on, and why a card needs a person.
ALTER TABLE "board_card_rounds" ADD COLUMN "startHeadSha" TEXT;
ALTER TABLE "board_cards" ADD COLUMN "needsPersonReason" TEXT;
