import {
  type BoardCardKind,
  TEXT_FENCE_INFO,
  type TextField,
  type TextFieldView,
} from '@nautelle/shared';
import type { TextNormalizeArgs } from '@nautelle/shared/protocol';
import type { TextNormalization } from '@prisma/client';
import { BoardWorld } from '../../board/testing/board-e2e';
import {
  type NormalizeSendResult,
  TextCommands,
  type TextRunnerState,
} from '../text-commands';
import { type NormalizeOutcome, TextNormalizer } from '../text-normalizer';
import { TextQueue, type TextQueueHandle } from '../text-queue';

/** A Russian card: "Add login" / "Users sign in with a password." */
export const RU_TITLE = 'Добавить вход';
export const RU_BODY = 'Пользователи входят по паролю.';

export interface AnswerField {
  id: string;
  english?: string;
  alreadyEnglish?: boolean;
}

/** The model's answer in the `agentdock-text` contract. */
export const textBlock = (
  fields: AnswerField[],
  kind?: BoardCardKind,
): string =>
  [
    'Done.',
    `\`\`\`${TEXT_FENCE_INFO}`,
    JSON.stringify({
      fields: fields.map((f) => ({
        id: f.id,
        alreadyEnglish: f.alreadyEnglish ?? false,
        ...(f.english !== undefined ? { english: f.english } : {}),
      })),
      ...(kind ? { kind } : {}),
    }),
    '```',
  ].join('\n');

/**
 * The text e2e world: the board's world, with `text.normalize` kept in the
 * process. `runnerState` is what the runner looks like, `sendAnswer` what
 * sending answers; `normalized()` lists what was sent. The queue's worker
 * does not run under `APP_ENV=test`: tests call `process` themselves.
 */
export class TextWorld extends BoardWorld {
  normalizer!: TextNormalizer;
  textCommands!: TextCommands;
  textQueue!: TextQueueHandle;
  runnerState: TextRunnerState = 'ready';
  sendAnswer: NormalizeSendResult = { status: 'ok' };

  override async init(): Promise<void> {
    await super.init();
    this.normalizer = this.ctx.app.get(TextNormalizer);
    this.textCommands = this.ctx.app.get(TextCommands);
    const queue = this.ctx.app.get(TextQueue).queue;
    if (!queue) throw new Error('the e2e suite needs TEST_REDIS_URL');
    this.textQueue = queue;
    jest
      .spyOn(this.textCommands, 'state')
      .mockImplementation(() => this.runnerState);
    jest
      .spyOn(this.textCommands, 'normalize')
      .mockImplementation(async () => this.sendAnswer);
  }

  override async reset(): Promise<void> {
    jest.mocked(this.textCommands.normalize).mockClear();
    this.runnerState = 'ready';
    this.sendAnswer = { status: 'ok' };
    await this.textQueue.obliterate({ force: true });
    await super.reset();
  }

  override async close(): Promise<void> {
    await this.textQueue.obliterate({ force: true });
    await super.close();
  }

  /** The `text.normalize` args sent, oldest first. */
  normalized(): TextNormalizeArgs[] {
    return jest
      .mocked(this.textCommands.normalize)
      .mock.calls.map(([, args]) => args);
  }

  /** Every request of project A, oldest first. */
  requests(): Promise<TextNormalization[]> {
    return this.ctx.prisma.textNormalization.findMany({
      where: { projectId: this.a },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  fields(row: TextNormalization): TextField[] {
    return row.fields as unknown as TextField[];
  }

  /** Runs one request's job; expects it to start, and returns its run. */
  async start(id: string): Promise<string> {
    const outcome = await this.normalizer.process({ normalizationId: id });
    if (outcome.kind !== 'started') {
      throw new Error(`not started: ${JSON.stringify(outcome)}`);
    }
    return outcome.runId;
  }

  process(id: string, extra: object = {}): Promise<NormalizeOutcome> {
    return this.normalizer.process({ normalizationId: id, ...extra });
  }

  /** The newest request of project A. */
  async latest(): Promise<TextNormalization> {
    const rows = await this.requests();
    const row = rows.at(-1);
    if (!row) throw new Error('no request');
    return row;
  }

  /** `text_normalize.finished` for `runId`, as the runner sends it. */
  finish(
    runId: string,
    result: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    return this.deliver('text_normalize.finished', {
      runId,
      projectId: this.a,
      ok: true,
      at: new Date().toISOString(),
      result,
      ...extra,
    });
  }

  /** `GET text-normalizations` as `session`; the views by `owner:field`. */
  async views(
    query: string,
    session = this.operator,
  ): Promise<Map<string, TextFieldView>> {
    const response = await session.get(
      `${this.path()}/text-normalizations?${query}`,
    );
    expect(response.status).toBe(200);
    return new Map(
      (response.body.fields as TextFieldView[]).map((f) => [
        `${f.ownerType}:${f.field}`,
        f,
      ]),
    );
  }
}
