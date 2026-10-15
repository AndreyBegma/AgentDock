import { CardDesignHarness } from '../design/testing/card-design-e2e';
import { TextCommands } from './text-commands';

/** Who reads normalization states and originals, and who changes them (D14, D13). */
describe('text normalization authorization (e2e)', () => {
  const h = new CardDesignHarness();

  beforeAll(() => h.start());
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    const commands = h.ctx.app.get(TextCommands);
    jest.spyOn(commands, 'state').mockReturnValue('ready');
    jest
      .spyOn(commands, 'normalize')
      .mockResolvedValue({ status: 'ok' as const });
  });
  afterEach(() => jest.restoreAllMocks());

  const views = (query: string) =>
    `/projects/${h.projectId}/text-normalizations?${query}`;
  const settings = () => `/projects/${h.projectId}/text-settings`;

  it('a non-member gets 404 on both GETs and on the settings', async () => {
    const card = await h.createCard({ title: 'Добавить вход' });
    const plan = await h.createPlan();
    expect((await h.outsider.get(views(`cardId=${card.id}`))).status).toBe(404);
    expect((await h.outsider.get(views(`planId=${plan.id}`))).status).toBe(404);
    expect((await h.outsider.get(settings())).status).toBe(404);
    // Members read both.
    expect((await h.viewer.get(views(`cardId=${card.id}`))).status).toBe(200);
    expect((await h.author.get(views(`planId=${plan.id}`))).status).toBe(200);
  });

  it("another user's private plan is 404; shared, it is readable", async () => {
    const plan = await h.createPlan();
    expect((await h.other.get(views(`planId=${plan.id}`))).status).toBe(404);
    // Site admins are no exception to a private plan (spec 172).
    expect((await h.admin.get(views(`planId=${plan.id}`))).status).toBe(404);
    await h.ctx.prisma.plan.update({
      where: { id: plan.id },
      data: { visibility: 'project' },
    });
    expect((await h.other.get(views(`planId=${plan.id}`))).status).toBe(200);
  });

  it("an operator cannot retry a request of another user's private plan", async () => {
    const plan = await h.createPlan();
    const row = await h.ctx.prisma.textNormalization.create({
      data: {
        projectId: h.projectId,
        ownerType: 'plan',
        planId: plan.id,
        fields: [
          {
            field: 'brief',
            original: 'x',
            sourceHash: '0'.repeat(64),
          },
        ],
        status: 'failed',
        failReason: 'run_failed',
      },
    });
    const retry = `/projects/${h.projectId}/text-normalizations/${row.id}/retry`;
    expect((await h.other.send('post', retry)).status).toBe(404);
    expect((await h.author.send('post', retry)).status).toBe(204);
  });

  it('an Inbox card is hidden from a viewer (#244 D8)', async () => {
    const card = await h.createCard();
    await h.ctx.prisma.boardCard.update({
      where: { id: card.id },
      data: { column: 'inbox', source: 'captured' },
    });
    expect((await h.viewer.get(views(`cardId=${card.id}`))).status).toBe(404);
    expect((await h.author.get(views(`cardId=${card.id}`))).status).toBe(200);
  });

  it('exactly one of cardId and planId, else 400', async () => {
    const card = await h.createCard();
    const plan = await h.createPlan();
    expect((await h.author.get(views(''))).status).toBe(400);
    expect(
      (await h.author.get(views(`cardId=${card.id}&planId=${plan.id}`))).status,
    ).toBe(400);
    expect((await h.author.get(views('cardId=a%20b'))).status).toBe(400);
  });

  it('only a project admin changes the switch', async () => {
    const body = { normalizeEnabled: false };
    expect((await h.author.send('put', settings(), body)).status).toBe(403);
    expect((await h.viewer.send('put', settings(), body)).status).toBe(403);
    const changed = await h.admin.send('put', settings(), body);
    expect(changed.status).toBe(200);
    expect((await h.viewer.get(settings())).body).toMatchObject({
      normalizeEnabled: false,
      updatedAt: expect.any(String),
    });
    expect(
      (await h.admin.send('put', settings(), { normalizeEnabled: 'no' }))
        .status,
    ).toBe(400);
  });
});
