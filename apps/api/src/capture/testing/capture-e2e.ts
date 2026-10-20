import { CAPTURE_FENCE_INFO } from '@nautelle/shared';
import type { CardsExtractArgs } from '@nautelle/shared/protocol';
import { BoardWorld, ROOT_A } from '../../board/testing/board-e2e';
import { CaptureService } from '../capture.service';
import { CaptureCommands, type ExtractSendResult } from '../capture-commands';
import { CaptureQueue, type CaptureQueueHandle } from '../capture-queue';

/** A prompt long enough on its own to pass `CAPTURE_MIN_INPUT_CHARS`. */
export const LONG_PROMPT =
  'The login page loops back to itself after the OAuth callback. ' +
  'We should fix that redirect loop later, after the release. ' +
  'Also the settings form forgets the timezone when saved twice; ' +
  'note it down so somebody picks it up. ' +
  'For now, just make the build pass and keep the tests green, please. ' +
  'And remember the flaky e2e on CI.';

export interface SuggestionInput {
  title: string;
  body?: string;
  kind?: 'feature' | 'bug';
  why?: string;
  confidence?: number;
  evidence: (string | number)[];
}

/** The model's answer in the D5 contract. */
export const cardsBlock = (cards: SuggestionInput[]): string =>
  [
    'Here is what I found.',
    `\`\`\`${CAPTURE_FENCE_INFO}`,
    JSON.stringify({
      cards: cards.map((c) => ({
        title: c.title,
        body: c.body ?? '',
        kind: c.kind ?? 'bug',
        why: c.why ?? 'The developer said to do it later.',
        confidence: c.confidence ?? 0.9,
        evidence: c.evidence,
      })),
    }),
    '```',
  ].join('\n');

/**
 * The capture e2e world: the board's world (two projects on one runner, a
 * Claude profile, admin, operator, viewer), with project A shipping content
 * and capture on. `cards.extract` never leaves the process: `extracted`
 * lists what was sent and `extractAnswer` is what the runner answers.
 */
export class CaptureWorld extends BoardWorld {
  capture!: CaptureService;
  captureCommands!: CaptureCommands;
  queue!: CaptureQueueHandle;
  extractAnswer: ExtractSendResult = { status: 'ok' };
  /** Set to make `cards.extract` not ready, like an offline runner. */
  runnerOffline = false;

  override async init(): Promise<void> {
    await super.init();
    this.capture = this.ctx.app.get(CaptureService);
    this.captureCommands = this.ctx.app.get(CaptureCommands);
    const queue = this.ctx.app.get(CaptureQueue).queue;
    if (!queue) throw new Error('the e2e suite needs TEST_REDIS_URL');
    this.queue = queue;
    jest
      .spyOn(this.captureCommands, 'ready')
      .mockImplementation(() => !this.runnerOffline);
    jest
      .spyOn(this.captureCommands, 'extract')
      .mockImplementation(async () => this.extractAnswer);
  }

  override async reset(): Promise<void> {
    jest.mocked(this.captureCommands.extract).mockClear();
    this.extractAnswer = { status: 'ok' };
    this.runnerOffline = false;
    await this.queue.obliterate({ force: true });
    await super.reset();
    await this.contentOn(true);
    await this.ctx.prisma.boardSettings.create({
      data: { projectId: this.a, captureEnabled: true },
    });
  }

  override async close(): Promise<void> {
    await this.queue.obliterate({ force: true });
    await super.close();
  }

  contentOn(on: boolean) {
    return this.ctx.prisma.project.update({
      where: { id: this.a },
      data: { shipSessionContent: on },
    });
  }

  /** The `cards.extract` args sent, oldest first. */
  extracted(): CardsExtractArgs[] {
    return jest
      .mocked(this.captureCommands.extract)
      .mock.calls.map(([, args]) => args);
  }

  /** Starts a manual Claude session in project A; returns its `sessions.id`. */
  async manualSession(externalId = 'm1'): Promise<string> {
    await this.hook('hook.session_started', externalId, {
      source: 'startup',
      cwd: ROOT_A,
      permissionMode: 'default',
    });
    const row = await this.ctx.prisma.agentSession.findFirstOrThrow({
      where: { externalId },
      select: { id: true, origin: true },
    });
    expect(row.origin).toBe('manual');
    return row.id;
  }

  /** A prompt the person typed, stored as content. */
  prompt(externalId: string, text: string) {
    return this.hook('hook.prompt_submitted', externalId, {
      chars: text.length,
      content: { text, truncated: false },
    });
  }

  /** Claude stopped, with its final response stored as content. */
  stopped(externalId: string, response?: string) {
    return this.hook(
      'hook.stopped',
      externalId,
      response === undefined
        ? {}
        : { response: { text: response, truncated: false } },
    );
  }

  /** The session's content rows, oldest first. */
  content(sessionId: string) {
    return this.ctx.prisma.sessionContent.findMany({
      where: { sessionId },
      orderBy: { id: 'asc' },
    });
  }

  /** `cards_extract.finished` for `runId`, as the runner sends it. */
  finish(
    runId: string,
    result: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    return this.deliver('cards_extract.finished', {
      runId,
      projectId: this.a,
      ok: true,
      at: new Date().toISOString(),
      result,
      ...extra,
    });
  }

  captures(sessionId?: string) {
    return this.ctx.prisma.cardCapture.findMany({
      where: { projectId: this.a, ...(sessionId ? { sessionId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  }

  inbox(projectId = this.a) {
    return this.ctx.prisma.boardCard.findMany({
      where: { projectId, column: 'inbox' },
      orderBy: { position: 'asc' },
    });
  }

  /**
   * A whole extraction: a manual session says `LONG_PROMPT`, capture runs,
   * and the model answers `cards`, each citing the prompt. Returns the
   * session's `sessions.id` and the capture's id.
   */
  async suggest(
    cards: Omit<SuggestionInput, 'evidence'>[],
    externalId = 'm1',
  ): Promise<{ sessionId: string; captureId: string; contentId: string }> {
    const known = await this.ctx.prisma.agentSession.findFirst({
      where: { externalId },
      select: { id: true },
    });
    const sessionId = known?.id ?? (await this.manualSession(externalId));
    await this.prompt(externalId, LONG_PROMPT);
    await this.age(sessionId, 60 * 60 * 1000);
    const outcome = await this.capture.extract({ sessionId });
    if (outcome.kind !== 'started') {
      throw new Error(`extraction did not start: ${JSON.stringify(outcome)}`);
    }
    const contentId = String((await this.content(sessionId)).at(-1)?.id);
    await this.finish(
      outcome.runId,
      cardsBlock(cards.map((c) => ({ ...c, evidence: [contentId] }))),
    );
    return { sessionId, captureId: outcome.captureId, contentId };
  }

  /** Moves every capture of the session back in time, past the 30-minute limit. */
  age(sessionId: string, ms: number) {
    return this.ctx.prisma.$executeRaw`
      UPDATE card_captures
      SET "createdAt" = "createdAt" - make_interval(secs => ${ms / 1000})
      WHERE "sessionId" = ${sessionId}`;
  }
}
