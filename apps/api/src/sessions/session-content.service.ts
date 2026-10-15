import {
  SESSION_CONTENT_PAGE_LIMIT,
  type SessionContentItem,
  type SessionContentPage,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { sessionNotFound } from './session-error';

/** Stored hook content of a project's sessions (ADR-0021): reads, purge, retention. */
@Injectable()
export class SessionContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * One page of a session's content, oldest first. The caller's role was
   * checked by the route; a session of another project is 404 like a missing
   * one, so a project's route never returns another's rows.
   */
  async page(
    projectId: string,
    sessionId: string,
    cursor: string | undefined,
  ): Promise<SessionContentPage> {
    const session = await this.prisma.agentSession.findFirst({
      where: { id: sessionId, projectId },
      select: { id: true },
    });
    if (!session) throw sessionNotFound();
    const rows = await this.prisma.sessionContent.findMany({
      where: { sessionId, projectId },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
      take: SESSION_CONTENT_PAGE_LIMIT + 1,
      ...(cursor ? { cursor: { id: BigInt(cursor) }, skip: 1 } : {}),
    });
    const page = rows.slice(0, SESSION_CONTENT_PAGE_LIMIT);
    const items = page.map(
      (row): SessionContentItem => ({
        id: row.id.toString(),
        kind: row.kind,
        toolUseId: row.toolUseId,
        toolName: row.toolName,
        at: row.at.toISOString(),
        text: row.text,
        truncated: row.truncated,
      }),
    );
    return {
      items,
      nextCursor:
        rows.length > SESSION_CONTENT_PAGE_LIMIT
          ? (items.at(-1)?.id ?? null)
          : null,
    };
  }

  /**
   * Admin purge: every content row of the project, and what card capture
   * derived from content (#244 D8): its Inbox cards and its capture rows.
   * Accepted cards are the person's and stay, unlinked from their capture.
   */
  async purge(projectId: string, ctx: AuditContext): Promise<void> {
    const [content, inbox, captures] = await this.prisma.$transaction([
      this.prisma.sessionContent.deleteMany({ where: { projectId } }),
      this.prisma.boardCard.deleteMany({
        where: { projectId, column: 'inbox' },
      }),
      this.prisma.cardCapture.deleteMany({ where: { projectId } }),
    ]);
    await this.audit.record({
      ...ctx,
      action: 'session_content.purged',
      target: { type: 'project', id: projectId },
      projectId,
      after: {
        count: content.count,
        inboxCards: inbox.count,
        captures: captures.count,
      },
      result: 'ok',
    });
  }

  /** Retention: rows older than their project's `sessionContentRetentionDays`. */
  async sweep(now: Date = new Date()): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM session_contents c
      USING projects p
      WHERE c."projectId" = p.id
        AND c."createdAt" < ${now}::timestamptz
          - make_interval(days => p."sessionContentRetentionDays")`;
  }
}
