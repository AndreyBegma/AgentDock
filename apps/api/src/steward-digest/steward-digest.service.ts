import {
  STEWARD_DEFAULTS,
  type StewardDigestTrigger,
  type StewardDigestView,
} from '@agentdock/shared';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  type DigestContent,
  StewardDigestComposer,
} from './steward-digest-composer';
import { digestView } from './steward-digest-format';
import { StewardDigestProse } from './steward-digest-prose';
import { StewardDigestTelegram } from './steward-digest-telegram';
import { dailyDueAt, dailyIsDue } from './steward-digest-time';

const HOUR_MS = 3_600_000;
/** A daily digest covers at most this much, however long the server was down. */
const DAILY_WINDOW_MAX_MS = 48 * HOUR_MS;
/** The window of a digest with no earlier one to continue from. */
const FIRST_WINDOW_MS = 24 * HOUR_MS;
/** An away-off older than this is not sent by a tick any more. */
const AWAY_OFF_LOOKBACK_MS = 15 * 60_000;

/** What one tick did; the e2e suites assert on it. */
export interface DigestPass {
  daily: number;
  awayOff: number;
}

interface CreatedDigest {
  view: StewardDigestView;
  projectName: string;
}

const notFound = (): HttpException =>
  new HttpException(
    { statusCode: 404, error: 'not_found', message: 'No digest yet' },
    404,
  );

/**
 * The Steward digest (#447 D14): once a day at the project's `digestTime`, and
 * when away mode is switched off. It composes the content from rows, stores it
 * in `steward_digests`, and sends it to Telegram when configured.
 *
 * Once stored, haiku writes its prose on the project's runner (#491,
 * `digest.compose`) and the row gets it before the digest is sent; with the
 * runner offline, or any failure, `prose` stays null and the digest is the
 * template. A project with Steward switched off gets no digest.
 */
@Injectable()
export class StewardDigestService {
  private readonly logger = new Logger(StewardDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly composer: StewardDigestComposer,
    private readonly prose: StewardDigestProse,
    private readonly telegram: StewardDigestTelegram,
  ) {}

  /** One scheduler tick: the daily digests that came due, and the away-offs. */
  async tick(now = new Date()): Promise<DigestPass> {
    const daily = await this.runDaily(now);
    const awayOff = await this.runAwayOff(now);
    return { daily, awayOff };
  }

  /** The newest digest of the project; 404 before the first one. */
  async latest(projectId: string): Promise<StewardDigestView> {
    const row = await this.prisma.stewardDigest.findFirst({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!row) throw notFound();
    return digestView(row);
  }

  /** Makes the daily digest of every project whose time has come. Returns how many. */
  async runDaily(now = new Date()): Promise<number> {
    const projects = await this.prisma.project.findMany({
      select: {
        id: true,
        displayName: true,
        stewardSettings: { select: { enabled: true, digestTime: true } },
        stewardDigests: {
          where: { trigger: 'daily' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    });
    let made = 0;
    for (const project of projects) {
      const settings = project.stewardSettings ?? STEWARD_DEFAULTS;
      if (!settings.enabled) continue;
      const lastAt = project.stewardDigests[0]?.createdAt ?? null;
      if (!dailyIsDue(now, settings.digestTime, lastAt)) continue;
      try {
        const created = await this.create({
          projectId: project.id,
          trigger: 'daily',
          to: now,
          // Due once per calendar day: a digest made since `due` is not repeated.
          guard: { since: dailyDueAt(now, settings.digestTime) },
        });
        if (created) {
          made += 1;
          await this.deliver(created, null);
        }
      } catch (error) {
        this.logger.error(
          `daily digest of project ${project.id} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return made;
  }

  /**
   * "While you were away" (D14): for every away mode switched off within the
   * last 15 minutes (the `runner.update` audit record carries it — there is no
   * event), one digest per project of that runner. The audit time is the
   * digest's `to`, which is also what keeps a second tick from repeating it.
   */
  async runAwayOff(now = new Date()): Promise<number> {
    const records = await this.prisma.auditRecord.findMany({
      where: {
        action: 'runner.update',
        targetType: 'runner',
        result: 'ok',
        ts: { gte: new Date(now.getTime() - AWAY_OFF_LOOKBACK_MS) },
        after: { path: ['awayMode'], equals: false },
      },
      orderBy: { seq: 'asc' },
      select: { targetId: true, ts: true, actorUserId: true },
    });
    let made = 0;
    for (const record of records) {
      if (!record.targetId) continue;
      made += await this.awayOff(
        record.targetId,
        record.ts,
        record.actorUserId,
      );
    }
    return made;
  }

  /** The away-off of one runner at `at`. Public so an event can call it later. */
  async awayOff(
    runnerId: string,
    at: Date,
    actorUserId: string | null = null,
  ): Promise<number> {
    const projects = await this.prisma.project.findMany({
      where: { runnerId },
      select: {
        id: true,
        stewardSettings: { select: { enabled: true } },
      },
    });
    if (projects.length === 0) return 0;
    const on = await this.prisma.auditRecord.findFirst({
      where: {
        action: 'runner.update',
        targetType: 'runner',
        targetId: runnerId,
        result: 'ok',
        ts: { lt: at },
        after: { path: ['awayMode'], equals: true },
      },
      orderBy: { seq: 'desc' },
      select: { ts: true },
    });
    const from = on?.ts ?? new Date(at.getTime() - FIRST_WINDOW_MS);
    let made = 0;
    for (const project of projects) {
      if (project.stewardSettings && !project.stewardSettings.enabled) continue;
      try {
        const created = await this.create({
          projectId: project.id,
          trigger: 'away_off',
          from,
          to: at,
          guard: { sameTo: at },
        });
        if (created) {
          made += 1;
          await this.deliver(created, actorUserId);
        }
      } catch (error) {
        this.logger.error(
          `away-off digest of project ${project.id} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return made;
  }

  /**
   * Composes and stores one digest under a per-project lock, so two instances
   * ticking together make one. `guard` says what makes it a repeat: a digest
   * of the same trigger since a time, or one that ends at the same instant.
   * The prose is asked after the lock is released — the runner call takes
   * seconds — and written onto the stored row.
   */
  private async create(args: {
    projectId: string;
    trigger: StewardDigestTrigger;
    from?: Date;
    to: Date;
    guard: { since: Date } | { sameTo: Date };
  }): Promise<CreatedDigest | null> {
    const stored = await this.store(args);
    if (!stored) return null;
    const prose = await this.prose.write(
      args.projectId,
      args.trigger,
      stored.content,
    );
    if (prose === null) return stored.created;
    const row = await this.prisma.stewardDigest.update({
      where: { id: stored.created.view.id },
      data: { prose },
    });
    return { ...stored.created, view: digestView(row) };
  }

  private async store(args: {
    projectId: string;
    trigger: StewardDigestTrigger;
    from?: Date;
    to: Date;
    guard: { since: Date } | { sameTo: Date };
  }): Promise<{ created: CreatedDigest; content: DigestContent } | null> {
    const { projectId, trigger, to, guard } = args;
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`steward-digest:${projectId}:${trigger}`}))`;
        const repeat = await tx.stewardDigest.findFirst({
          where: {
            projectId,
            trigger,
            ...('since' in guard
              ? { createdAt: { gte: guard.since } }
              : { to: guard.sameTo }),
          },
          select: { id: true },
        });
        if (repeat) return null;

        const previous =
          args.from === undefined
            ? await tx.stewardDigest.findFirst({
                where: { projectId, trigger },
                orderBy: { createdAt: 'desc' },
                select: { to: true },
              })
            : null;
        const earliest = new Date(to.getTime() - DAILY_WINDOW_MAX_MS);
        const from =
          args.from ??
          (previous && previous.to > earliest
            ? previous.to
            : new Date(to.getTime() - FIRST_WINDOW_MS));

        const content: DigestContent = await this.composer.compose(
          projectId,
          from,
          to,
        );
        const row = await tx.stewardDigest.create({
          data: {
            projectId,
            trigger,
            from,
            to,
            // Plain strings and arrays of them: JSON by construction.
            content: content as unknown as Prisma.InputJsonValue,
            prose: null,
          },
        });
        const project = await tx.project.findUnique({
          where: { id: projectId },
          select: { displayName: true },
        });
        return {
          created: {
            view: digestView(row),
            projectName: project?.displayName ?? 'Project',
          },
          content,
        };
      },
      { timeout: 30_000 },
    );
  }

  /** Telegram after the digest is stored; a failure here never loses the digest. */
  private async deliver(
    created: CreatedDigest,
    preferUserId: string | null,
  ): Promise<void> {
    try {
      await this.telegram.send(created.view, created.projectName, preferUserId);
    } catch (error) {
      this.logger.warn(
        `digest ${created.view.id} not delivered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
