import { BoardWorld } from './testing/board-e2e';

/** Every write route of the board, with a body its DTO accepts. */
const WRITES: ['post' | 'patch' | 'delete', string, object?][] = [
  ['post', '/board/cards', { title: 'x' }],
  ['patch', '/board/cards/1', { title: 'y' }],
  ['post', '/board/cards/1/move', { column: 'finished', index: 0 }],
  ['post', '/board/cards/1/run', {}],
  ['post', '/board/cards/1/feedback', { text: 'z' }],
  ['post', '/board/cards/1/finish'],
  ['post', '/board/cards/1/accept'],
  ['post', '/board/cards/1/stop'],
  ['delete', '/board/cards/1'],
];
const READS = ['/board', '/board/cards/1', '/board-settings'];
const SETTINGS = { issueOnRun: true, specOnRun: false, maxRunning: 2 };

describe('board authorization (e2e)', () => {
  const w = new BoardWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(async () => {
    await w.reset();
    await w.createCard();
  });
  afterEach(() => w.work.settled());

  it('a viewer reads everything and is 403 on every write', async () => {
    for (const path of READS) {
      expect([path, (await w.viewer.get(`${w.path()}${path}`)).status]).toEqual(
        [path, 200],
      );
    }
    for (const [method, path, body] of WRITES) {
      const response = await w.viewer.send(method, `${w.path()}${path}`, body);
      expect([method, path, response.status]).toEqual([method, path, 403]);
    }
    expect(
      (await w.viewer.send('put', `${w.path()}/board-settings`, SETTINGS))
        .status,
    ).toBe(403);
    expect(w.sent('card.run')).toEqual([]);
    expect((await w.card(1)).title).toBe('Add login');
  });

  it('a non-member is 404 on every route, read or write', async () => {
    for (const path of READS) {
      expect([
        path,
        (await w.outsider.get(`${w.path()}${path}`)).status,
      ]).toEqual([path, 404]);
    }
    for (const [method, path, body] of WRITES) {
      const response = await w.outsider.send(
        method,
        `${w.path()}${path}`,
        body,
      );
      expect([method, path, response.status]).toEqual([method, path, 404]);
    }
    // An operator of another project is a non-member here.
    expect((await w.operatorOfB.get(`${w.path()}/board`)).status).toBe(404);
  });

  it('only a project admin puts the settings', async () => {
    const operator = await w.operator.send(
      'put',
      `${w.path()}/board-settings`,
      SETTINGS,
    );
    expect(operator.status).toBe(403);

    const admin = await w.admin.send(
      'put',
      `${w.path()}/board-settings`,
      SETTINGS,
    );
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({ ...SETTINGS, isDefault: false });

    const settings = await w.viewer.get(`${w.path()}/board-settings`);
    expect(settings.body).toMatchObject({ maxRunning: 2 });
  });

  it('refuses maxRunning outside 1–10', async () => {
    for (const maxRunning of [0, 11]) {
      const response = await w.admin.send('put', `${w.path()}/board-settings`, {
        ...SETTINGS,
        maxRunning,
      });
      expect(response.status).toBe(400);
    }
  });

  describe('the Inbox (#244 D8): operators only', () => {
    /** Card 2 of project A, a suggestion in the Inbox. */
    const suggestion = async () => {
      const now = new Date();
      await w.ctx.prisma.boardCard.create({
        data: {
          projectId: w.a,
          number: 2,
          shortId: 'inbox001',
          title: 'Suggested',
          column: 'inbox',
          position: 1,
          source: 'captured',
          issueOnRun: false,
          specOnRun: false,
          movedAt: now,
          evidence: [{ contentId: '1', kind: 'prompt', excerpt: 'secret' }],
        },
      });
    };
    const INBOX_WRITES: [string, object?][] = [
      ['/board/cards/2/accept-suggestion', {}],
      ['/board/cards/2/dismiss'],
      ['/board/inbox/dismiss-all'],
    ];

    beforeEach(suggestion);

    it("a viewer's board has no Inbox, and an Inbox card is not found", async () => {
      const viewer = await w.viewer.get(`${w.path()}/board`);
      expect(viewer.status).toBe(200);
      const columns = (viewer.body.columns as { column: string }[]).map(
        (c) => c.column,
      );
      expect(columns).toEqual(['todo', 'in_progress', 'finished', 'completed']);
      expect(JSON.stringify(viewer.body)).not.toContain('Suggested');
      expect((await w.viewer.get(`${w.path()}/board/cards/2`)).status).toBe(
        404,
      );
      expect((await w.viewer.get(`${w.path()}/board/cards/1`)).status).toBe(
        200,
      );

      const operator = await w.operator.get(`${w.path()}/board`);
      expect(operator.body.columns[0]).toMatchObject({ column: 'inbox' });
      const card = await w.operator.get(`${w.path()}/board/cards/2`);
      expect(card.status).toBe(200);
      expect(card.body.evidence).toHaveLength(1);
    });

    it('a viewer is 403 on accept, dismiss and the captures list', async () => {
      for (const [path, body] of INBOX_WRITES) {
        const response = await w.viewer.send(
          'post',
          `${w.path()}${path}`,
          body,
        );
        expect([path, response.status]).toEqual([path, 403]);
      }
      expect((await w.viewer.get(`${w.path()}/board/captures`)).status).toBe(
        403,
      );
      expect(await w.ctx.prisma.boardCard.count({ where: { number: 2 } })).toBe(
        1,
      );
    });

    it('a non-member is 404 on them', async () => {
      for (const [path, body] of INBOX_WRITES) {
        const response = await w.outsider.send(
          'post',
          `${w.path()}${path}`,
          body,
        );
        expect([path, response.status]).toEqual([path, 404]);
      }
      expect((await w.outsider.get(`${w.path()}/board/captures`)).status).toBe(
        404,
      );
    });

    it('an operator lists the captures', async () => {
      const response = await w.operator.get(`${w.path()}/board/captures`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [], nextCursor: null });
    });
  });

  describe('the pull request and accept with merge (#273 D16): operators only', () => {
    const MERGE = { merge: { headSha: 'a'.repeat(40) } };

    beforeEach(() =>
      w.ctx.prisma.boardCard.updateMany({
        where: { projectId: w.a },
        data: { prNumber: 77, column: 'finished' },
      }),
    );

    it('a viewer is 403 on GET …/pull-request and on accept with merge', async () => {
      expect(
        (await w.viewer.get(`${w.path()}/board/cards/1/pull-request`)).status,
      ).toBe(403);
      expect(
        (await w.viewer.send('post', `${w.path()}/board/cards/1/accept`, MERGE))
          .status,
      ).toBe(403);
      expect(jest.mocked(w.commands.inspectPr)).not.toHaveBeenCalled();
      expect(w.sent('card.merge')).toEqual([]);
    });

    it('a non-member is 404 on them', async () => {
      expect(
        (await w.outsider.get(`${w.path()}/board/cards/1/pull-request`)).status,
      ).toBe(404);
      expect(
        (
          await w.outsider.send(
            'post',
            `${w.path()}/board/cards/1/accept`,
            MERGE,
          )
        ).status,
      ).toBe(404);
      expect(w.sent('card.merge')).toEqual([]);
    });
  });

  it('a card of another project is not found through this project', async () => {
    await w.createCard({ title: 'Other' }, w.operatorOfB, w.b);
    await w.ctx.prisma.boardCard.deleteMany({ where: { projectId: w.a } });
    const response = await w.operator.get(`${w.path()}/board/cards/1`);
    expect(response.status).toBe(404);
  });
});
