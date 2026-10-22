-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "autoRunArmedById" TEXT;

-- AddForeignKey
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_autoRunArmedById_fkey" FOREIGN KEY ("autoRunArmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
