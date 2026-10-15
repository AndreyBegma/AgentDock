import {
  CAPTURE_PAGE_SIZE,
  type CardCapturePage,
  type CardCaptureView,
} from '@agentdock/shared';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsOptional, Matches } from 'class-validator';
import { PrismaService } from '../database/prisma.service';
import { usageByRun } from '../history/run-usage';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';

/** `GET /board/captures`. */
export class CapturePageQueryDto {
  /** The last id of the previous page. */
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: 'cursor is not a capture id' })
  cursor?: string;
}

/**
 * The project's extractions, newest first (issue #244 "API"): status, skip
 * reason, cost and how many cards each suggested — never content. Operators
 * and above (D8).
 */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class CaptureController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('board/captures')
  @ProjectRole('operator')
  async captures(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: CapturePageQueryDto,
  ): Promise<CardCapturePage> {
    const cursor = query.cursor
      ? await this.prisma.cardCapture.findFirst({
          where: { id: query.cursor, projectId: access.projectId },
          select: { id: true },
        })
      : null;
    const rows = await this.prisma.cardCapture.findMany({
      where: { projectId: access.projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: CAPTURE_PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
    });
    const page = rows.slice(0, CAPTURE_PAGE_SIZE);
    const usage = await usageByRun(
      this.prisma,
      page.flatMap((row) => (row.runId ? [row.runId] : [])),
    );
    const items = page.map(
      (row): CardCaptureView => ({
        id: row.id,
        sessionId: row.sessionId,
        status: row.status,
        skipReason: row.skipReason,
        error: row.error,
        suggested: row.suggested,
        inputChars: row.inputChars,
        runId: row.runId,
        costUsd: row.runId ? (usage.get(row.runId)?.costUsd ?? null) : null,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      }),
    );
    return {
      items,
      nextCursor:
        rows.length > CAPTURE_PAGE_SIZE ? (items.at(-1)?.id ?? null) : null,
    };
  }
}
