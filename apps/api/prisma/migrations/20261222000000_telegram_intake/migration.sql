-- #574: the New work intake a linked Telegram chat runs with /new.
CREATE TABLE "telegram_intakes" (
    "userId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "projectId" TEXT NOT NULL,
    "planId" TEXT,
    "shown" TEXT,
    "thinkingMessageId" INTEGER,
    "controlsMessageId" INTEGER,
    "questionMessages" JSONB NOT NULL DEFAULT '{}',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_intakes_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX "telegram_intakes_planId_key" ON "telegram_intakes"("planId");

CREATE INDEX "telegram_intakes_projectId_idx" ON "telegram_intakes"("projectId");

ALTER TABLE "telegram_intakes" ADD CONSTRAINT "telegram_intakes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "telegram_links"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "telegram_intakes" ADD CONSTRAINT "telegram_intakes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "telegram_intakes" ADD CONSTRAINT "telegram_intakes_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
