import { CAPTURE_DISMISSAL_DEDUPE_DAYS } from '@nautelle/shared';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../database/prisma.service';

/** Daily at 03:45 (issue #244 "Jobs"), after session content's 03:30. */
const RETENTION_CRON = '45 3 * * *';
const JOB_NAME = 'card-capture-retention';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CaptureSweep {
  inboxCards: number;
  results: number;
  dismissals: number;
}

/**
 * Card capture retention (issue #244 D8, ADR-0026 §6): Inbox cards and the
 * stored model results are content-derived, so they go when their project's
 * session content would (`sessionContentRetentionDays`); dismissals go after
 * `CAPTURE_DISMISSAL_DEDUPE_DAYS`, when they no longer block anything.
 * Accepted cards are the person's and stay.
 */
@Injectable()
export class CaptureRetention implements OnApplicationBootstrap {
  private readonly logger = new Logger(CaptureRetention.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const job = CronJob.from({
      cronTime: RETENTION_CRON,
      onTick: () => this.run(),
    });
    this.scheduler.addCronJob(JOB_NAME, job);
    job.start();
  }

  async sweep(now: Date = new Date()): Promise<CaptureSweep> {
    const inboxCards = await this.prisma.$executeRaw`
      DELETE FROM board_cards c
      USING projects p
      WHERE c."projectId" = p.id
        AND c."column" = 'inbox'::"BoardColumn"
        AND c."createdAt" < ${now}::timestamptz
          - make_interval(days => p."sessionContentRetentionDays")`;
    const results = await this.prisma.$executeRaw`
      UPDATE card_captures cc
      SET "resultText" = NULL
      FROM projects p
      WHERE cc."projectId" = p.id
        AND cc."resultText" IS NOT NULL
        AND cc."createdAt" < ${now}::timestamptz
          - make_interval(days => p."sessionContentRetentionDays")`;
    const { count: dismissals } = await this.prisma.cardDismissal.deleteMany({
      where: {
        createdAt: {
          lt: new Date(now.getTime() - CAPTURE_DISMISSAL_DEDUPE_DAYS * DAY_MS),
        },
      },
    });
    return { inboxCards, results, dismissals };
  }

  private async run(): Promise<void> {
    try {
      const swept = await this.sweep();
      const total = swept.inboxCards + swept.results + swept.dismissals;
      if (total > 0) {
        this.logger.log(
          `deleted ${swept.inboxCards} Inbox cards, ${swept.results} results, ${swept.dismissals} dismissals`,
        );
      }
    } catch (error) {
      this.logger.error(
        `card capture retention failed: ${(error as Error).message}`,
      );
    }
  }
}
