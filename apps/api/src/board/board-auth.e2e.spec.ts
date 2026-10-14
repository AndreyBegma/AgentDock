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

  it('a card of another project is not found through this project', async () => {
    await w.createCard({ title: 'Other' }, w.operatorOfB, w.b);
    await w.ctx.prisma.boardCard.deleteMany({ where: { projectId: w.a } });
    const response = await w.operator.get(`${w.path()}/board/cards/1`);
    expect(response.status).toBe(404);
  });
});
