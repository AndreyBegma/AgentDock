-- CreateEnum
CREATE TYPE "CardEffort" AS ENUM ('low', 'medium', 'high');

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "effort" "CardEffort",
ADD COLUMN     "recommendedEffort" "CardEffort";
