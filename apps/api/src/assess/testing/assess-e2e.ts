import type { CardAssessArgs } from '@nautelle/shared/protocol';
import type { Run } from '@prisma/client';
import { TextWorld } from '../../text/testing/text-e2e';
import {
  AssessCommands,
  type AssessRunnerState,
  type AssessSendResult,
} from '../assess-commands';
import { AssessQueue, type AssessQueueHandle } from '../assess-queue';
import { type AssessOutcome, CardAssessor } from '../card-assessor';

/** An answer in the D6 contract. */
export const assessAnswer = (
  work = 'sonnet',
  design = 'opus',
  extra: Record<string, unknown> = {},
  effort = 'medium',
): string =>
  JSON.stringify({
    work: {
      model: work,
      effort,
      class: 'mechanical',
      signals: [],
      reason: `Work fits ${work}.`,
    },
    design: { model: design, reason: `Design fits ${design}.` },
    ...extra,
  });

/**
 * The assessment e2e world (#322): the text world — board and
 * normalization — with `card.assess` kept in the process. `assessState` is
 * what the runner looks like, `assessAnswer` what sending answers;
 * `assessed()` lists what was sent. The queue's worker does not run under
 * `APP_ENV=test`: `drain()` runs the waiting jobs as it would.
 */
export class AssessWorld extends TextWorld {
  assessor!: CardAssessor;
  assessCommands!: AssessCommands;
  assessQueue!: AssessQueueHandle;
  assessState: AssessRunnerState = 'ready';
  assessSend: AssessSendResult = { status: 'ok' };

  override async init(): Promise<void> {
    await super.init();
    this.assessor = this.ctx.app.get(CardAssessor);
    this.assessCommands = this.ctx.app.get(AssessCommands);
    const queue = this.ctx.app.get(AssessQueue).queue;
    if (!queue) throw new Error('the e2e suite needs TEST_REDIS_URL');
    this.assessQueue = queue;
    jest
      .spyOn(this.assessCommands, 'state')
      .mockImplementation(() => this.assessState);
    jest
      .spyOn(this.assessCommands, 'assess')
      .mockImplementation(async () => this.assessSend);
  }

  override async reset(): Promise<void> {
    jest.mocked(this.assessCommands.assess).mockClear();
    this.assessState = 'ready';
    this.assessSend = { status: 'ok' };
    await this.assessQueue.obliterate({ force: true });
    await super.reset();
  }

  override async close(): Promise<void> {
    await this.assessQueue.obliterate({ force: true });
    await super.close();
  }

  /** The `card.assess` args sent, oldest first. */
  assessed(): CardAssessArgs[] {
    return jest
      .mocked(this.assessCommands.assess)
      .mock.calls.map(([, args]) => args);
  }

  /** The ids of the waiting jobs, oldest first. */
  async waiting(): Promise<string[]> {
    const jobs = await this.assessQueue.getJobs(['waiting'], 0, -1, true);
    return jobs.map((j) => j.id ?? '');
  }

  /** Runs every waiting job once, as the worker would; their outcomes. */
  async drain(): Promise<AssessOutcome[]> {
    const jobs = await this.assessQueue.getJobs(['waiting'], 0, -1, true);
    const outcomes: AssessOutcome[] = [];
    for (const job of jobs) {
      outcomes.push(await this.assessor.process(job.data));
      await job.remove();
    }
    return outcomes;
  }

  assessRuns(): Promise<Run[]> {
    return this.ctx.prisma.run.findMany({
      where: { kind: 'card_assess' },
      orderBy: { startedAt: 'asc' },
    });
  }

  /** `card_assess.finished` for `runId`, as the runner sends it. */
  finishAssess(
    runId: string,
    result: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    return this.deliver('card_assess.finished', {
      runId,
      projectId: this.a,
      ok: true,
      at: new Date().toISOString(),
      result,
      ...extra,
    });
  }
}
