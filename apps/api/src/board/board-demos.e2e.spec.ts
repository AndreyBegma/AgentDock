import { CARD_DEMO_EVENTS, DEMO_MERGE_WAIT_MS } from '@nautelle/shared';
import { BoardShipping } from './board-shipping';
import {
  BoardWorld,
  cardChecks,
  HEAD_SHA,
  ok,
  prInspection,
} from './testing/board-e2e';

const PENDING = {
  checks: [{ name: 'ci/check', bucket: 'pending', link: null }],
};
const NEXT_HEAD = 'b'.repeat(40);
const UI_FILES = [
  { path: 'apps/web/src/app/login/page.tsx', additions: 30, deletions: 2 },
  { path: 'apps/api/src/auth/auth.service.ts', additions: 4, deletions: 0 },
];
const API_FILES = [
  { path: 'apps/api/src/auth/auth.service.ts', additions: 4, deletions: 0 },
];

/**
 * C-370 (ADR-0095): a feature card whose PR turned green and changes the
 * project's UI paths is recorded as a demo video. The demo never holds the
 * card out of Finished; auto-merge waits for it, at most
 * `DEMO_MERGE_WAIT_MS`.
 */
describe('demo videos of green cards (e2e, C-370)', () => {
  const w = new BoardWorld();
  let shipping: BoardShipping;

  beforeAll(async () => {
    await w.init();
    shipping = w.ctx.app.get(BoardShipping);
  });
  afterAll(() => w.close());
  beforeEach(async () => {
    await w.reset();
    w.checksServed = true;
    w.handlers['pr.inspect'] = () => ok(prInspection({ files: UI_FILES }));
  });
  afterEach(() => w.work.settled());

  const checksAnswer = (extra: Record<string, unknown>) => {
    w.handlers['card.checks'] = () => ok(cardChecks(extra));
  };

  const enableDemos = async (enabled = true) => {
    const response = await w.admin.send('patch', `${w.path()}/demos/settings`, {
      enabled,
    });
    expect(response.status).toBe(200);
  };

  const setAutoMerge = async (autoMergeCards: boolean | null) => {
    const response = await w.admin.send('put', `${w.path()}/board-settings`, {
      issueOnRun: false,
      specOnRun: true,
      maxRunning: 3,
      autoMergeCards,
    });
    expect(response.status).toBe(200);
  };

  /** C-1 ran and its worker ended while its checks were pending. */
  const ended = async () => {
    checksAnswer(PENDING);
    await w.createCard();
    expect((await w.runCard(1)).status).toBe(200);
    const { rounds } = await w.card(1);
    await w.ctx.prisma.boardCardRound.update({
      where: { id: rounds[rounds.length - 1].id },
      data: { startedAt: new Date(Date.now() - 60_000) },
    });
    const card = await w.card(1);
    await w.deliver('card_run.phase_changed', {
      cardId: card.id,
      runId: rounds[rounds.length - 1].runId,
      projectId: card.projectId,
      at: new Date().toISOString(),
      phase: 'ended',
      exitCode: 0,
    });
    await w.work.settled();
  };

  /** C-1 ran and finished while its checks were pending; nothing merged. */
  const finishedPending = async () => {
    await ended();
    await w.ctx.prisma.boardCard.updateMany({
      data: { column: 'finished', ciState: 'pending' },
    });
    expect(w.sent('card.merge')).toEqual([]);
  };

  /** The poller reads the card's checks `extra` (green by default). */
  const polled = async (extra: Record<string, unknown> = {}) => {
    checksAnswer(extra);
    await shipping.poll();
    await w.work.settled();
  };

  const demos = () =>
    w.ctx.prisma.cardDemo.findMany({ orderBy: { createdAt: 'asc' } });

  const demoStatus = async (
    demoId: string,
    status: 'failed' | 'skipped',
    reason: string,
  ) => {
    await w.deliver('demo.status', {
      cardId: (await w.card(1)).id,
      projectId: w.a,
      demoId,
      status,
      reason,
      at: new Date().toISOString(),
    });
    await w.work.settled();
  };

  describe('when a card records', () => {
    it('records a feature card whose green PR changes a UI path, and sends card.demo', async () => {
      await enableDemos();
      await finishedPending();
      await polled();

      const [demo] = await demos();
      expect(demo).toMatchObject({
        trigger: 'auto',
        status: 'queued',
        round: 1,
        headSha: HEAD_SHA,
        requestedById: null,
      });
      const card = await w.card(1);
      expect(w.demosSent()).toEqual([
        expect.objectContaining({
          cardId: card.id,
          card: 1,
          round: 1,
          demoId: demo.id,
          worktree: expect.objectContaining({ shortId: card.shortId }),
        }),
      ]);
      // The card is Finished as before; only the merge waits.
      expect(card).toMatchObject({ column: 'finished', ciState: 'green' });
    });

    it('moves a card that turns green to Finished, and holds only its merge', async () => {
      await enableDemos();
      await ended();
      expect((await w.card(1)).column).toBe('in_progress');
      await polled();
      expect(await w.card(1)).toMatchObject({
        column: 'finished',
        ciState: 'green',
        needsPerson: false,
      });
      expect(await demos()).toHaveLength(1);
      expect(w.sent('card.merge')).toEqual([]);
    });

    it('records nothing for a bug card', async () => {
      await enableDemos();
      await finishedPending();
      await w.ctx.prisma.boardCard.updateMany({ data: { kind: 'bug' } });
      await polled();
      expect(await demos()).toEqual([]);
      expect(w.demosSent()).toEqual([]);
      expect(w.sent('card.merge')).toHaveLength(1);
    });

    it('records nothing when the PR changes no UI path', async () => {
      await enableDemos();
      w.handlers['pr.inspect'] = () => ok(prInspection({ files: API_FILES }));
      await finishedPending();
      await polled();
      expect(await demos()).toEqual([]);
      expect(w.sent('card.merge')).toHaveLength(1);
    });

    it('records nothing with demo videos off', async () => {
      await finishedPending();
      await polled();
      expect(await demos()).toEqual([]);
      expect(w.sent('card.merge')).toHaveLength(1);
    });

    it('records a head once, however often the poller reads it', async () => {
      await enableDemos();
      await finishedPending();
      await polled();
      await polled();
      await polled();
      expect(await demos()).toHaveLength(1);
      expect(w.demosSent()).toHaveLength(1);
    });

    it('skips the demo with the reason when the runner does not record demos', async () => {
      await enableDemos();
      w.unserved.add('card.demo');
      await finishedPending();
      await polled();
      const [demo] = await demos();
      expect(demo).toMatchObject({
        trigger: 'auto',
        status: 'skipped',
        reason: 'The runner does not record demos; update it',
      });
      expect(w.demosSent()).toEqual([]);
      // A skipped demo holds nothing.
      expect(w.sent('card.merge')).toHaveLength(1);
    });
  });

  describe('a new head', () => {
    it('supersedes the demo of the old head, and records its own', async () => {
      await enableDemos();
      await finishedPending();
      await polled();
      const [first] = await demos();

      await polled({ headSha: NEXT_HEAD });
      const [old, next] = await demos();
      expect(old).toMatchObject({
        id: first.id,
        status: 'skipped',
        reason: 'Superseded by the newer head bbbbbbb',
      });
      expect(next).toMatchObject({
        trigger: 'auto',
        status: 'queued',
        headSha: NEXT_HEAD,
      });
      expect(w.demosSent()).toHaveLength(2);
      expect(w.sent('card.merge')).toEqual([]);
    });
  });

  describe('auto-merge', () => {
    it.each([
      'failed',
      'skipped',
    ] as const)('waits for the demo, and merges once it is %s', async (status) => {
      await enableDemos();
      await finishedPending();
      await polled();
      await polled();
      expect(w.sent('card.merge')).toEqual([]);

      const [demo] = await demos();
      await demoStatus(demo.id, status, 'readyUrl never answered');
      await polled();
      const [merge] = w.sent('card.merge');
      expect(merge).toMatchObject({ pr: 77 });
      const card = await w.card(1);
      expect(card.mergedAt).not.toBeNull();
      // A failed demo is a warning only.
      expect(card.needsPerson).toBe(false);
      const failed = await w.ctx.prisma.event.findMany({
        where: { type: CARD_DEMO_EVENTS.failed },
      });
      expect(failed).toHaveLength(status === 'failed' ? 1 : 0);
    });

    it(`merges after ${DEMO_MERGE_WAIT_MS / 60_000} minutes, whatever the demo's status`, async () => {
      await enableDemos();
      await finishedPending();
      await polled();
      expect(w.sent('card.merge')).toEqual([]);

      await w.ctx.prisma.cardDemo.updateMany({
        data: { createdAt: new Date(Date.now() - DEMO_MERGE_WAIT_MS - 1_000) },
      });
      await polled();
      expect(w.sent('card.merge')).toHaveLength(1);
      // The runner may still finish it.
      expect((await demos())[0].status).toBe('queued');
    });

    it('is off: the demo is recorded and nothing merges', async () => {
      await setAutoMerge(false);
      await enableDemos();
      await finishedPending();
      await polled();
      expect(await demos()).toHaveLength(1);
      expect(w.demosSent()).toHaveLength(1);

      const [demo] = await demos();
      await demoStatus(demo.id, 'skipped', 'No UI change');
      await polled();
      expect(w.sent('card.merge')).toEqual([]);
    });
  });
});
