import { CaptureRetention } from './capture-retention.job';
import { CaptureWorld } from './testing/capture-e2e';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('card capture retention and purge (e2e)', () => {
  const w = new CaptureWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  /** Moves project A's cards and captures `days` back. */
  const backdate = async (days: number) => {
    const when = new Date(Date.now() - days * DAY_MS);
    await w.ctx.prisma.boardCard.updateMany({
      where: { projectId: w.a },
      data: { createdAt: when },
    });
    await w.ctx.prisma.cardCapture.updateMany({
      where: { projectId: w.a },
      data: { createdAt: when },
    });
  };

  it('a content purge deletes Inbox cards and capture rows, not accepted cards', async () => {
    await w.suggest([{ title: 'Keep me' }, { title: 'Purge me' }]);
    const [keep] = await w.inbox();
    expect(
      (
        await w.operator.send(
          'post',
          `${w.path()}/board/cards/${keep.number}/accept-suggestion`,
          {},
        )
      ).status,
    ).toBe(200);
    const { number: manual } = await w.createCard({ title: 'Manual' });

    const response = await w.admin.send(
      'delete',
      `${w.path()}/session-content`,
    );
    expect(response.status).toBe(204);

    expect(await w.inbox()).toEqual([]);
    expect(await w.captures()).toEqual([]);
    const accepted = await w.card(keep.number);
    expect(accepted).toMatchObject({
      column: 'todo',
      source: 'captured',
      captureId: null,
    });
    expect((await w.card(manual)).column).toBe('todo');
    const [audit] = await w.audit('session_content.purged');
    expect(audit.after).toMatchObject({ inboxCards: 1, captures: 1 });
  });

  it('retention deletes Inbox cards past the content retention, and the stored results', async () => {
    await w.ctx.prisma.project.update({
      where: { id: w.a },
      data: { sessionContentRetentionDays: 30 },
    });
    await w.suggest([
      { title: 'Old suggestion' },
      { title: 'Accepted long ago' },
    ]);
    const [, accept] = await w.inbox();
    await w.operator.send(
      'post',
      `${w.path()}/board/cards/${accept.number}/accept-suggestion`,
      {},
    );
    await backdate(31);
    await w.suggest([{ title: 'Fresh suggestion' }], 'm2');

    const swept = await w.ctx.app.get(CaptureRetention).sweep();
    expect(swept).toMatchObject({ inboxCards: 1, results: 1 });

    expect((await w.inbox()).map((c) => c.title)).toEqual(['Fresh suggestion']);
    expect((await w.card(accept.number)).column).toBe('todo');
    const captures = await w.captures();
    expect(captures.map((c) => c.resultText === null)).toEqual([true, false]);
    // The rows stay: the History and the settings list still show them.
    expect(captures).toHaveLength(2);
  });

  it('retention follows each project’s own retention days', async () => {
    await w.ctx.prisma.project.update({
      where: { id: w.a },
      data: { sessionContentRetentionDays: 60 },
    });
    await w.suggest([{ title: 'Within 60 days' }]);
    await backdate(31);
    expect(await w.ctx.app.get(CaptureRetention).sweep()).toMatchObject({
      inboxCards: 0,
      results: 0,
    });
    expect(await w.inbox()).toHaveLength(1);
  });

  it('deletes dismissals older than 90 days', async () => {
    const now = new Date();
    await w.ctx.prisma.cardDismissal.createMany({
      data: [
        {
          projectId: w.a,
          fingerprint: 'a'.repeat(64),
          title: 'Old',
          createdAt: new Date(now.getTime() - 91 * DAY_MS),
        },
        {
          projectId: w.a,
          fingerprint: 'b'.repeat(64),
          title: 'Recent',
          createdAt: new Date(now.getTime() - 89 * DAY_MS),
        },
      ],
    });
    expect(await w.ctx.app.get(CaptureRetention).sweep(now)).toMatchObject({
      dismissals: 1,
    });
    expect(
      (await w.ctx.prisma.cardDismissal.findMany()).map((d) => d.title),
    ).toEqual(['Recent']);
  });
});
