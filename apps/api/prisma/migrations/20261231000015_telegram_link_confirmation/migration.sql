-- C-147 (D-16): `/start <code>` leaves a pending link that the user confirms in the web app.
-- CreateTable
CREATE TABLE "telegram_pending_links" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "username" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_pending_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_pending_links_userId_key" ON "telegram_pending_links"("userId");

-- CreateIndex
CREATE INDEX "telegram_pending_links_expiresAt_idx" ON "telegram_pending_links"("expiresAt");

-- AddForeignKey
ALTER TABLE "telegram_pending_links" ADD CONSTRAINT "telegram_pending_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
