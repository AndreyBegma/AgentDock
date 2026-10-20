import type { BoardCardDetail, TaskDesignView } from '@nautelle/shared';
import type { CardCommandName } from '@nautelle/shared/protocol';
import {
  BoardCommands,
  type BoardSendResult,
} from '../../board/board-commands';
import { BoardWork } from '../../board/board-work';
import type { Session } from '../../test/e2e-app';
import { DesignHarness } from './design-e2e';

type CardHandler = (args: Record<string, unknown>) => BoardSendResult<unknown>;

/**
 * The design harness with the board's commands stubbed as well (#243): a
 * card's design turns go through the stubbed `plan.turn`; Run and an
 * auto-run send `card.run` to `cardHandlers` (a missing one answers `ok`
 * with a plausible output). `cardSent` lists what was sent.
 */
export class CardDesignHarness extends DesignHarness {
  boardCommands!: BoardCommands;
  work!: BoardWork;
  cardHandlers: Partial<Record<CardCommandName | 'issue.create', CardHandler>> =
    {};
  cardSent: { name: string; args: Record<string, unknown> }[] = [];

  async start(): Promise<void> {
    await super.start();
    this.boardCommands = this.ctx.app.get(BoardCommands);
    this.work = this.ctx.app.get(BoardWork);
  }

  async reset(): Promise<void> {
    await super.reset();
    this.cardHandlers = {};
    this.cardSent = [];
    jest.spyOn(this.boardCommands, 'assertReady').mockImplementation(() => {});
    jest
      .spyOn(this.boardCommands, 'send')
      .mockImplementation(async (_runner, name, args) =>
        this.answer(name, args as Record<string, unknown>),
      );
    jest
      .spyOn(this.boardCommands, 'createIssue')
      .mockImplementation(async (_runner, args) =>
        this.answer('issue.create', { ...args }),
      );
    jest
      .spyOn(this.boardCommands, 'closeDesign')
      .mockImplementation(async (_runner, args) => {
        this.cardSent.push({ name: 'plan.close', args: { ...args } });
        return { status: 'ok', output: { removed: true } };
      });
  }

  private answer(
    name: CardCommandName | 'issue.create',
    args: Record<string, unknown>,
  ): BoardSendResult<never> {
    this.cardSent.push({ name, args });
    const handler = this.cardHandlers[name];
    if (handler) return handler(args) as BoardSendResult<never>;
    const defaults: Record<string, unknown> = {
      'card.run': {
        phase: 'starting',
        tmuxSession: `nautelle-card-${String(args.shortId)}`,
      },
      'card.close': {
        stopped: false,
        worktreeRemoved: true,
        branchDeleted: false,
      },
      'issue.create': {
        number: 41,
        url: 'https://github.com/acme/widget/issues/41',
        queued: false,
      },
    };
    return { status: 'ok', output: defaults[name] } as BoardSendResult<never>;
  }

  /** The args of every board command `name` sent, oldest first. */
  cardSentOf(name: string): Record<string, unknown>[] {
    return this.cardSent.filter((c) => c.name === name).map((c) => c.args);
  }

  cardPath(number?: number): string {
    return `/projects/${this.projectId}/board/cards${number === undefined ? '' : `/${number}`}`;
  }

  cardDesignBase(number: number): string {
    return `${this.cardPath(number)}/design`;
  }

  async createCard(
    body: Record<string, unknown> = {},
    session: Session = this.author,
  ): Promise<BoardCardDetail> {
    const response = await session.send('post', this.cardPath(), {
      title: 'Add login',
      body: 'Users sign in with a password.',
      ...body,
    });
    if (response.status !== 201) {
      throw new Error(`create card → ${response.status} ${response.text}`);
    }
    return response.body as BoardCardDetail;
  }

  async cardDesign(
    number: number,
    session: Session = this.author,
  ): Promise<TaskDesignView> {
    return (await session.get(this.cardDesignBase(number)))
      .body as TaskDesignView;
  }

  /** A card whose design is switched on with `variants`. */
  async designedCard(variants = 1): Promise<BoardCardDetail> {
    const card = await this.createCard();
    const on = await this.author.send(
      'patch',
      this.cardDesignBase(card.number),
      {
        needed: true,
        variantCount: variants,
      },
    );
    if (on.status !== 200) {
      throw new Error(`design on → ${on.status} ${on.text}`);
    }
    return card;
  }

  /** The card's design turn that is queued or running. */
  activeCardTurn(cardId: string) {
    return this.ctx.prisma.planTurn.findFirstOrThrow({
      where: { cardId, phase: { in: ['queued', 'running'] } },
    });
  }

  /** The runner reports the card's active design turn finished with `resultText`. */
  async finishCard(
    cardId: string,
    resultText: string,
    extra: { phase?: 'succeeded' | 'failed' } = {},
  ): Promise<void> {
    const turn = await this.activeCardTurn(cardId);
    await this.sinks.dispatch(this.runnerId, [
      this.event('plan_turn.finished', {
        planId: cardId,
        turnId: turn.id,
        runId: turn.runId,
        projectId: this.projectId,
        phase: extra.phase ?? 'succeeded',
        at: new Date().toISOString(),
        exitCode: 0,
        resultText,
        resultTruncated: false,
      }),
    ]);
  }

  async close(): Promise<void> {
    await this.work.settled();
    await this.ctx.app.close();
  }
}
