import {
  CAPTURE_INBOX_MAX,
  CAPTURE_MAX_PER_PROJECT_PER_DAY,
  CAPTURE_OFFLINE_BACKOFF_MAX_MS,
  CAPTURE_SESSION_MIN_INTERVAL_MS,
} from '@nautelle/shared';
import { BudgetGate } from '../budgets';
import { CaptureWorld, cardsBlock, LONG_PROMPT } from './testing/capture-e2e';

const HOUR_MS = 60 * 60 * 1000;

describe('card capture limits (e2e)', () => {
  const w = new CaptureWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  /** A manual session with enough new content to extract. */
  const ready = async (externalId = 'm1') => {
    const id = await w.manualSession(externalId);
    await w.prompt(externalId, LONG_PROMPT);
    return id;
  };

  /** `n` extractions that ran in project A within the last day. */
  const ranToday = async (n: number) => {
    const other = await w.manualSession('other');
    const now = new Date();
    for (let i = 0; i < n; i++) {
      const run = await w.ctx.prisma.run.create({
        data: {
          kind: 'card_capture',
          projectId: w.a,
          status: 'succeeded',
          triggeredByType: 'capture',
          startedAt: now,
          updatedAt: now,
        },
      });
      await w.ctx.prisma.cardCapture.create({
        data: {
          projectId: w.a,
          sessionId: other,
          runId: run.id,
          contentFromId: 0n,
          contentToId: 0n,
          inputChars: 400,
          status: 'succeeded',
          createdAt: new Date(now.getTime() - (i + 1) * 60_000),
        },
      });
    }
  };

  it('skips the 49th extraction of a project in 24 h as rate_limited', async () => {
    const id = await ready();
    await ranToday(CAPTURE_MAX_PER_PROJECT_PER_DAY);
    const outcome = await w.capture.extract({ sessionId: id });
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'rate_limited' });
    expect(w.extracted()).toEqual([]);
    const [skip] = await w.captures(id);
    expect(skip).toMatchObject({
      status: 'skipped',
      skipReason: 'rate_limited',
      runId: null,
    });
  });

  it('runs the 48th', async () => {
    const id = await ready();
    await ranToday(CAPTURE_MAX_PER_PROJECT_PER_DAY - 1);
    expect(await w.capture.extract({ sessionId: id })).toMatchObject({
      kind: 'started',
    });
  });

  it('skips inbox_full when the Inbox holds 30 cards', async () => {
    const id = await ready();
    const now = new Date();
    for (let i = 1; i <= CAPTURE_INBOX_MAX; i++) {
      await w.ctx.prisma.boardCard.create({
        data: {
          projectId: w.a,
          number: i,
          shortId: `inbox${String(i).padStart(3, '0')}`,
          title: `Suggestion ${i}`,
          column: 'inbox',
          position: i,
          source: 'captured',
          issueOnRun: false,
          specOnRun: false,
          movedAt: now,
        },
      });
    }
    const outcome = await w.capture.extract({ sessionId: id });
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'inbox_full' });
    expect(w.extracted()).toEqual([]);
  });

  it('skips budget_exceeded on a project budget hard stop, asking for no user', async () => {
    const id = await ready();
    const gate = w.ctx.app.get(BudgetGate);
    const check = jest.spyOn(gate, 'check').mockResolvedValue({
      allowed: false,
      budgetId: 'b1',
      scope: 'project',
      resetsAt: new Date(),
    });
    try {
      const outcome = await w.capture.extract({ sessionId: id });
      expect(outcome).toMatchObject({
        kind: 'skipped',
        reason: 'budget_exceeded',
      });
      expect(check).toHaveBeenCalledWith({ projectId: w.a, userId: null });
      expect(w.extracted()).toEqual([]);
    } finally {
      check.mockRestore();
    }
  });

  it('skips too_little under 300 characters, keeping the watermark', async () => {
    const id = await w.manualSession();
    await w.prompt('m1', 'fix it');
    const outcome = await w.capture.extract({ sessionId: id });
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'too_little' });
    // More content later is still read: the short prompt waited for it.
    await w.prompt('m1', LONG_PROMPT);
    expect(await w.capture.extract({ sessionId: id })).toMatchObject({
      kind: 'started',
    });
    const [rowShort] = await w.content(id);
    expect(w.extracted()[0].prompt).toContain(`id="${rowShort.id}"`);
  });

  it('runs one extraction per project at a time', async () => {
    const first = await ready('m1');
    const second = await ready('m2');
    expect(await w.capture.extract({ sessionId: first })).toMatchObject({
      kind: 'started',
    });
    expect(await w.capture.extract({ sessionId: second })).toMatchObject({
      kind: 'deferred',
      why: 'busy',
    });
    // Its result frees the project.
    const [running] = await w.captures(first);
    await w.finish(running.runId as string, cardsBlock([]));
    expect(await w.capture.extract({ sessionId: second })).toMatchObject({
      kind: 'started',
    });
  });

  it('runs one extraction per session in 30 minutes, deferring the next', async () => {
    const id = await ready();
    const started = await w.capture.extract({ sessionId: id });
    expect(started).toMatchObject({ kind: 'started' });
    const [capture] = await w.captures(id);
    await w.finish(capture.runId as string, cardsBlock([]));

    await w.prompt('m1', LONG_PROMPT);
    const outcome = await w.capture.extract({ sessionId: id });
    expect(outcome).toMatchObject({
      kind: 'deferred',
      why: 'session_interval',
    });
    if (outcome.kind !== 'deferred') throw new Error('unreachable');
    expect(outcome.untilMs).toBe(
      capture.createdAt.getTime() + CAPTURE_SESSION_MIN_INTERVAL_MS,
    );

    await w.age(id, CAPTURE_SESSION_MIN_INTERVAL_MS);
    expect(await w.capture.extract({ sessionId: id })).toMatchObject({
      kind: 'started',
    });
  });

  it('backs off while the runner is offline, then skips runner_offline after 6 h', async () => {
    const id = await ready();
    w.runnerOffline = true;
    const now = new Date();
    const first = await w.capture.extract({ sessionId: id }, now);
    expect(first).toMatchObject({
      kind: 'deferred',
      why: 'runner_offline',
      offlineSince: now.getTime(),
    });

    const later = new Date(now.getTime() + 2 * HOUR_MS);
    const second = await w.capture.extract(
      { sessionId: id, offlineSince: now.getTime() },
      later,
    );
    expect(second).toMatchObject({ kind: 'deferred', why: 'runner_offline' });
    if (second.kind !== 'deferred') throw new Error('unreachable');
    expect(second.untilMs).toBeGreaterThan(later.getTime());
    expect(second.untilMs).toBeLessThanOrEqual(
      now.getTime() + CAPTURE_OFFLINE_BACKOFF_MAX_MS,
    );

    const gaveUp = await w.capture.extract(
      { sessionId: id, offlineSince: now.getTime() },
      new Date(now.getTime() + CAPTURE_OFFLINE_BACKOFF_MAX_MS),
    );
    expect(gaveUp).toMatchObject({
      kind: 'skipped',
      reason: 'runner_offline',
    });
    expect(w.extracted()).toEqual([]);
  });

  it('retries a runner failure once, on the same content', async () => {
    const id = await ready();
    w.extractAnswer = { status: 'error', message: 'internal' };
    const outcome = await w.capture.extract({ sessionId: id });
    expect(outcome).toMatchObject({ kind: 'failed' });
    if (outcome.kind !== 'failed') throw new Error('unreachable');
    const retry = await w.queue.getJob(`capture-retry-${outcome.captureId}`);
    expect(retry?.data).toEqual({ sessionId: id, retryOf: outcome.captureId });

    // The retry fails too: no third attempt.
    const again = await w.capture.extract({
      sessionId: id,
      retryOf: outcome.captureId,
    });
    expect(again).toMatchObject({ kind: 'failed' });
    expect(w.extracted()).toHaveLength(2);
    expect(w.extracted()[1].prompt).toBe(w.extracted()[0].prompt);
    if (again.kind !== 'failed') throw new Error('unreachable');
    expect(
      await w.queue.getJob(`capture-retry-${again.captureId}`),
    ).toBeUndefined();
  });
});
