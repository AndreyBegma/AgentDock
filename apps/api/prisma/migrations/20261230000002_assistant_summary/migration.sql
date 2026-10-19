-- AlterEnum
ALTER TYPE "LlmFeature" ADD VALUE 'assistant_summary';

-- AlterTable
ALTER TABLE "assistant_conversations" ADD COLUMN     "summary" TEXT,
ADD COLUMN     "summaryUpTo" TEXT;
