-- CreateEnum
CREATE TYPE "TextEngine" AS ENUM ('deepl', 'runner');

-- AlterTable
ALTER TABLE "text_normalizations" ADD COLUMN     "billedChars" INTEGER,
ADD COLUMN     "engine" "TextEngine";
