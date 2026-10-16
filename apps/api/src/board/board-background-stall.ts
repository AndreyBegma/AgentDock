import {
  CARD_BACKGROUND_STALL_MINUTES_DEFAULT,
  CARD_BACKGROUND_STALL_MINUTES_MIN,
  CARD_BACKGROUND_STALLED_EVENT,
  CARD_BACKGROUND_SWEEP_MS,
  type CardBackgroundStalledEventData,
} from '@agentdock/shared';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BoardWork } from './board-work';

const MINUTE_MS = 60_000;

/**
 * #390: a round that has waited on its own background tasks longer than the
 * project's `backgroundStallMinutes` raises one `card.background_stalled` —
 * a warn activity item and a notification. "Once" is `backgroundStalledAt`:
 * set here by a conditional update, cleared when the round leaves
 * `background`, so the next stall fires again. The event's key is the round
 * and the stall's start, so two API instances record it once.
 */
@Injectable()
export class BoardBackgroundStall
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BoardBackgroundStall.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
  ) {}

  onApplicationBootstrap(): void {
    // Tests drive `tick()` themselves.
    if (process.env.APP_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`background stall sweep failed: ${reason}`);
      });
    }, CARD_BACKGROUND_SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** One look at every round in `background`; the number of stalls raised. */
  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.pass(now);
    } finally {
      this.running = false;
    }
  }

  private async pass(now: Date): Promise<number> {
    const rounds = await this.prisma.boardCardRound.findMany({
      where: {
        phase: 'background',
        backgroundStalledAt: null,
        backgroundAt: {
          lte: new Date(
            now.getTime() - CARD_BACKGROUND_STALL_MINUTES_MIN * MINUTE_MS,
          ),
        },
      },
      include: {
        card: {
          select: {
            id: true,
            number: true,
            title: true,
            projectId: true,
            project: {
              select: {
                runnerId: true,
                rootPath: true,
                repo: true,
                boardSettings: { select: { backgroundStallMinutes: true } },
              },
            },
          },
        },
      },
    });
    let raised = 0;
    for (const round of rounds) {
      const since = round.backgroundAt;
      if (!since) continue;
      const minutes =
        round.card.project.boardSettings?.backgroundStallMinutes ??
        CARD_BACKGROUND_STALL_MINUTES_DEFAULT;
      if (now.getTime() - since.getTime() < minutes * MINUTE_MS) continue;
      const fired = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.boardCardRound.updateMany({
          where: {
            id: round.id,
            phase: 'background',
            backgroundStalledAt: null,
            backgroundAt: since,
          },
          data: { backgroundStalledAt: now },
        });
        if (count === 0) return false;
        const data: CardBackgroundStalledEventData = {
          cardId: round.card.id,
          number: round.card.number,
          title: round.card.title,
          round: round.round,
          minutes,
        };
        await this.work.serverEvent(
          tx,
          round.card.project,
          CARD_BACKGROUND_STALLED_EVENT,
          `${round.id}:${since.toISOString()}`,
          { ...data },
        );
        return true;
      });
      if (fired) {
        raised++;
        this.work.publish(round.card.projectId, round.card.id);
      }
    }
    return raised;
  }
}
