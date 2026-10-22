import type {
  PlanDetail,
  PlanListView,
  PlanTaskVersionsView,
  TaskPage,
} from '@nautelle/shared';
import type { Session } from '../test/e2e-app';
import { decomposed, PlannerHarness, task } from './testing/planner-e2e';

type Method = 'get' | 'post' | 'put';

/** Every route that names a plan, with a body each accepts. */
const planRoutes = (
  base: string,
  turnId: string,
): [Method, string, object][] => [
  ['get', base, {}],
  ['get', `${base}/tasks/t1/versions`, {}],
  ['post', `${base}/turns`, { message: 'hi' }],
  ['post', `${base}/tasks/t1/turns`, { message: 'hi' }],
  ['post', `${base}/tasks/t1/review`, { decision: 'approve' }],
  ['post', `${base}/revise`, {}],
  ['post', `${base}/visibility`, { visibility: 'project' }],
  ['post', `${base}/send`, {}],
  ['post', `${base}/cards`, {}],
  ['post', `${base}/archive`, {}],
  ['post', `${base}/turns/${turnId}/cancel`, {}],
  ['post', `${base}/turns/${turnId}/retry`, {}],
];

const call = (
  session: Session,
  [method, path, body]: [Method, string, object],
) => (method === 'get' ? session.get(path) : session.send(method, path, body));

const items = async (session: Session, path: string) =>
  ((await session.get(path)).body as TaskPage | PlanListView).items;

describe('planner authorization (e2e)', () => {
  const h = new PlannerHarness();
  let plan: PlanDetail;
  let turnId: string;

  beforeAll(() => h.start());
  afterAll(() => h.ctx.app.close());
  beforeEach(async () => {
    await h.reset();
    plan = await decomposed(h, [task('t1'), task('t2')]);
    turnId = plan.turns[0].id;
  });
  afterEach(() => jest.restoreAllMocks());

  const status = async (session: Session, route: [Method, string, object]) => [
    route[1],
    (await call(session, route)).status,
  ];

  const share = () =>
    h.author.send('post', `${h.base(plan.id)}/visibility`, {
      visibility: 'project',
    });

  it('answers 404 to another operator on every path of a private plan, /tasks included', async () => {
    expect(plan.visibility).toBe('private');
    const sentBefore = h.sent.length;
    for (const route of planRoutes(h.base(plan.id), turnId)) {
      expect(await status(h.other, route)).toEqual([route[1], 404]);
    }
    expect(h.sent.length).toBe(sentBefore);
    expect(await items(h.other, h.base())).toEqual([]);
    expect(await items(h.other, '/tasks')).toEqual([]);
    expect(await items(h.other, `/tasks?planId=${plan.id}`)).toEqual([]);

    // The author sees all of it.
    expect((await h.author.get(h.base(plan.id))).status).toBe(200);
    expect(await items(h.author, '/tasks')).toHaveLength(2);
  });

  it('hides a private plan from a site admin too (spec open question, default)', async () => {
    expect((await h.admin.get(h.base(plan.id))).status).toBe(404);
    const versions = `${h.base(plan.id)}/tasks/t1/versions`;
    expect((await h.admin.get(versions)).status).toBe(404);
    expect(await items(h.admin, h.base())).toEqual([]);
    expect(await items(h.admin, '/tasks')).toEqual([]);
  });

  it('lets another operator read and act on the plan once it is shared', async () => {
    expect((await share()).status).toBe(200);
    const [audit] = await h.auditOf('plan.shared');
    expect(audit.after).toEqual({ visibility: 'project' });

    expect((await h.other.get(h.base(plan.id))).status).toBe(200);
    const versions = await h.other.get(`${h.base(plan.id)}/tasks/t1/versions`);
    expect(versions.status).toBe(200);
    expect((versions.body as PlanTaskVersionsView).versions).toHaveLength(1);
    expect(await items(h.other, h.base())).toHaveLength(1);
    expect(await items(h.other, '/tasks')).toHaveLength(2);
    const reviewed = await h.other.send(
      'post',
      `${h.base(plan.id)}/tasks/t1/review`,
      { decision: 'approve' },
    );
    expect(reviewed.status).toBe(200);
    const turn = await h.other.send(
      'post',
      `${h.base(plan.id)}/tasks/t2/turns`,
      { message: 'Let us talk' },
    );
    expect(turn.status).toBe(201);
    // Only the author changes visibility.
    const unshare = await h.other.send(
      'post',
      `${h.base(plan.id)}/visibility`,
      { visibility: 'private' },
    );
    expect(unshare.status).toBe(403);
  });

  it('answers 404 to a non-member everywhere, shared or not', async () => {
    await share();
    for (const route of planRoutes(h.base(plan.id), turnId)) {
      expect(await status(h.outsider, route)).toEqual([route[1], 404]);
    }
    expect((await h.outsider.get(h.base())).status).toBe(404);
    expect(await items(h.outsider, '/tasks')).toEqual([]);
    const settings = `/projects/${h.projectId}/planner/settings`;
    expect((await h.outsider.get(settings)).status).toBe(404);
  });

  it('lets a viewer read a shared plan and answers 403 to every write', async () => {
    expect((await h.viewer.get(h.base(plan.id))).status).toBe(404);
    await share();
    const seen = await h.viewer.get(h.base(plan.id));
    expect(seen.status).toBe(200);
    // A viewer reads each turn's input and result as the author does (ADR-0050).
    const [first] = (seen.body as PlanDetail).turns;
    expect(first.input).toEqual(plan.turns[0].input);
    expect(first.input).not.toBeNull();
    expect(first.resultText).toEqual(
      (await h.detail(plan.id)).turns[0].resultText,
    );
    expect(first.resultText).toBeTruthy();
    const versions = `${h.base(plan.id)}/tasks/t1/versions`;
    expect((await h.viewer.get(versions)).status).toBe(200);
    expect(await items(h.viewer, '/tasks')).toHaveLength(2);
    const sentBefore = h.sent.length;
    for (const route of planRoutes(h.base(plan.id), turnId)) {
      if (route[0] === 'get') continue;
      expect(await status(h.viewer, route)).toEqual([route[1], 403]);
    }
    const create = await h.viewer.send('post', h.base(), {
      brief: 'x',
      mode: 'batch',
    });
    expect(create.status).toBe(403);
    expect(h.sent.length).toBe(sentBefore);
  });

  it('answers 403 to an operator on PUT settings and 200 to a project admin', async () => {
    const url = `/projects/${h.projectId}/planner/settings`;
    expect((await h.author.get(url)).status).toBe(200);
    expect((await h.viewer.get(url)).status).toBe(200);
    const body = { specOutput: 'issue_body' };
    expect((await h.author.send('put', url, body)).status).toBe(403);
    expect((await h.admin.send('put', url, body)).status).toBe(200);
  });
});
