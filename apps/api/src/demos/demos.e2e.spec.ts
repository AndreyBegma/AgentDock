import { createHash } from 'node:crypto';
import {
  type CardDemoView,
  DEMO_SECRETS_MAX,
  DEMO_UI_PATHS_DEFAULT,
  type DemoSecretView,
} from '@nautelle/shared';
import {
  FILES,
  useTempAttachmentsDir,
} from '../attachments/testing/attachments-e2e';
import { BoardWorld } from '../board/testing/board-e2e';
import {
  generateRunnerToken,
  hashRunnerToken,
  tokenPrefix,
} from '../runners/credentials';

useTempAttachmentsDir();

const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
const SECRET = 'hunter2-correct-horse';

/** JSON of rows that carry a `bigint` (an audit record's `seq`). */
const json = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );

const sha256 = (body: Buffer): string =>
  createHash('sha256').update(body).digest('hex');

describe('demo videos (e2e, C-368, ADR-0090)', () => {
  const w = new BoardWorld();
  let previousKey: string | undefined;

  beforeAll(async () => {
    previousKey = process.env.APP_ENCRYPTION_KEY;
    process.env.APP_ENCRYPTION_KEY = ENCRYPTION_KEY;
    await w.init();
  });
  afterAll(async () => {
    await w.close();
    if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previousKey;
  });
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  const settingsUrl = () => `${w.path()}/demos/settings`;
  const secretUrl = (name: string) => `${w.path()}/demos/secrets/${name}`;
  const demosUrl = (number = 1) => `${w.path()}/board/cards/${number}/demos`;

  const enable = async () => {
    const response = await w.admin.send('patch', settingsUrl(), {
      enabled: true,
    });
    expect(response.status).toBe(200);
  };
  const putSecret = (name: string, value = SECRET, session = w.admin) =>
    session.send('put', secretUrl(name), { value });

  /** Card 1, run once, with demo videos on. */
  const ranCard = async () => {
    await enable();
    await w.createCard();
    expect((await w.runCard(1)).status).toBe(200);
  };
  const requested = async (): Promise<CardDemoView> => {
    const response = await w.operator.send('post', demosUrl());
    expect(response.status).toBe(201);
    return response.body as CardDemoView;
  };

  const tokenFor = async (runnerId: string): Promise<string> => {
    const token = generateRunnerToken();
    await w.ctx.prisma.runner.update({
      where: { id: runnerId },
      data: {
        tokenPrefix: tokenPrefix(token),
        tokenHash: await hashRunnerToken(token),
      },
    });
    return token;
  };
  const foreignToken = async () =>
    tokenFor(
      (await w.ctx.prisma.runner.create({ data: { name: 'laptop' } })).id,
    );

  const env = (demoId: string, token?: string, number = 1) => {
    const req = w.ctx.http().get(`/runner/cards/${number}/demos/${demoId}/env`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const video = (
    demoId: string,
    token: string | undefined,
    body: Buffer = FILES.mp4,
    options: { sha?: string; type?: string; number?: number } = {},
  ) => {
    const req = w.ctx
      .http()
      .post(`/runner/cards/${options.number ?? 1}/demos/${demoId}/video`)
      .set('Content-Type', options.type ?? 'video/mp4')
      .set('x-demo-sha256', options.sha ?? sha256(body))
      .set('x-demo-duration-ms', '4200');
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
      body,
    );
  };

  describe('settings', () => {
    it('is off by default with the default UI paths, for any member', async () => {
      const response = await w.viewer.get(settingsUrl());
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        enabled: false,
        uiPaths: [...DEMO_UI_PATHS_DEFAULT],
        telegram: true,
      });
      expect((await w.outsider.get(settingsUrl())).status).toBe(404);
    });

    it('lets an admin change them, audited; an operator may not', async () => {
      expect(
        (await w.operator.send('patch', settingsUrl(), { enabled: true }))
          .status,
      ).toBe(403);

      const response = await w.admin.send('patch', settingsUrl(), {
        enabled: true,
        uiPaths: [' apps/web/** ', 'packages/glass-ui/**'],
        telegram: false,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        enabled: true,
        uiPaths: ['apps/web/**', 'packages/glass-ui/**'],
        telegram: false,
      });
      expect((await w.viewer.get(settingsUrl())).body).toEqual(response.body);

      const [record] = await w.audit('demo.settings_updated');
      expect(record.before).toMatchObject({ enabled: false });
      expect(record.after).toMatchObject({ enabled: true, telegram: false });
    });

    it('is 400 for an unknown field or a path that is not a string', async () => {
      for (const body of [
        { other: true },
        { uiPaths: [1] },
        { uiPaths: [''] },
      ]) {
        expect((await w.admin.send('patch', settingsUrl(), body)).status).toBe(
          400,
        );
      }
    });
  });

  describe('Demo env secrets', () => {
    it('stores a value sealed and never answers, lists or audits it', async () => {
      const put = await putSecret('LOGIN_PASSWORD');
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ name: 'LOGIN_PASSWORD' });
      expect(json(put.body)).not.toContain(SECRET);

      const list = await w.viewer.get(`${w.path()}/demos/secrets`);
      expect(list.status).toBe(200);
      expect((list.body as DemoSecretView[]).map((s) => s.name)).toEqual([
        'LOGIN_PASSWORD',
      ]);
      expect(json(list.body)).not.toContain(SECRET);

      const row = await w.ctx.prisma.projectDemoSecret.findFirstOrThrow({
        where: { projectId: w.a, name: 'LOGIN_PASSWORD' },
      });
      expect(row.valueCiphertext.startsWith('v1:')).toBe(true);
      expect(row.valueCiphertext).not.toContain(SECRET);

      // Replacing it keeps one row and says so in the audit.
      expect((await putSecret('LOGIN_PASSWORD', 'another-one')).status).toBe(
        200,
      );
      const records = await w.audit('demo.secret_set');
      expect(records.map((r) => r.after)).toEqual([
        { name: 'LOGIN_PASSWORD', replaced: false },
        { name: 'LOGIN_PASSWORD', replaced: true },
      ]);
      expect(json(records)).not.toContain(SECRET);
      expect(json(records)).not.toContain('another-one');
    });

    it('lets only an admin write, and deletes with an audit record', async () => {
      expect((await putSecret('TOKEN', SECRET, w.operator)).status).toBe(403);
      expect((await putSecret('TOKEN')).status).toBe(200);
      expect((await w.operator.send('delete', secretUrl('TOKEN'))).status).toBe(
        403,
      );
      expect((await w.admin.send('delete', secretUrl('TOKEN'))).status).toBe(
        204,
      );
      expect((await w.admin.send('delete', secretUrl('TOKEN'))).status).toBe(
        404,
      );
      const [record] = await w.audit('demo.secret_deleted');
      expect(record.before).toEqual({ name: 'TOKEN' });
    });

    it('is 400 for a name that is not an environment variable name, or an empty value', async () => {
      for (const name of ['lower', '1ABC', 'A-B', 'A'.repeat(65)]) {
        expect((await putSecret(name)).status).toBe(400);
      }
      expect((await putSecret('EMPTY', '')).status).toBe(400);
    });

    it(`refuses one past ${DEMO_SECRETS_MAX} with too_many_secrets`, async () => {
      for (let i = 0; i < DEMO_SECRETS_MAX; i += 1) {
        expect((await putSecret(`S_${i}`)).status).toBe(200);
      }
      const refused = await putSecret('ONE_MORE');
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('too_many_secrets');
      // Replacing one still works at the cap.
      expect((await putSecret('S_0', 'new')).status).toBe(200);
    });
  });

  describe('Record again', () => {
    it('is 409 with demo videos off, and for a card that never ran', async () => {
      await w.createCard();
      const off = await w.operator.send('post', demosUrl());
      expect(off.status).toBe(409);
      expect(off.body.error).toBe('demos_disabled');

      await enable();
      const never = await w.operator.send('post', demosUrl());
      expect(never.status).toBe(409);
      expect(never.body.error).toBe('no_round');
    });

    it('queues a manual demo of the latest round, audited; a second one waits', async () => {
      await ranCard();
      const demo = await requested();
      expect(demo).toMatchObject({
        round: 1,
        status: 'queued',
        trigger: 'manual',
        attachmentId: null,
        contentUrl: null,
      });
      expect(demo.scenarioPath).toMatch(
        /^demoflow\/cards\/C-1-.+\.demo\.json$/,
      );
      const [record] = await w.audit('demo.requested');
      expect(record.after).toMatchObject({ number: 1, demoId: demo.id });

      const again = await w.operator.send('post', demosUrl());
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('demo_in_flight');

      const list = await w.viewer.get(demosUrl());
      expect(list.status).toBe(200);
      expect((list.body as CardDemoView[]).map((d) => d.id)).toEqual([demo.id]);
    });

    it('is 403 for a viewer, 404 for an outsider and an unknown card', async () => {
      await ranCard();
      expect((await w.viewer.send('post', demosUrl())).status).toBe(403);
      expect((await w.outsider.get(demosUrl())).status).toBe(404);
      expect((await w.operator.get(demosUrl(99))).status).toBe(404);
    });
  });

  describe("the runner's secret fetch", () => {
    it("opens the project's secrets for its runner only, while the demo is active", async () => {
      await putSecret('LOGIN_PASSWORD');
      await ranCard();
      const demo = await requested();
      const own = await tokenFor(w.runnerId);

      expect((await env(demo.id)).status).toBe(401);
      expect((await env(demo.id, generateRunnerToken())).status).toBe(401);
      expect((await env(demo.id, await foreignToken())).status).toBe(403);
      expect((await env('nope', own)).status).toBe(404);
      expect((await env(demo.id, own, 2)).status).toBe(404);

      const response = await env(demo.id, own);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ env: { LOGIN_PASSWORD: SECRET } });

      await w.deliver('demo.status', {
        cardId: (await w.card(1)).id,
        projectId: w.a,
        demoId: demo.id,
        status: 'skipped',
        at: new Date().toISOString(),
        reason: 'No UI change',
      });
      const finished = await env(demo.id, own);
      expect(finished.status).toBe(409);
      expect(finished.body.error).toBe('demo_not_active');
    });
  });

  describe("the runner's video upload", () => {
    it('stores the video on the card and makes the demo ready, audited', async () => {
      await ranCard();
      const demo = await requested();
      const token = await tokenFor(w.runnerId);

      const response = await video(demo.id, token);
      expect(response.status).toBe(201);
      const ready = response.body as CardDemoView;
      expect(ready).toMatchObject({
        id: demo.id,
        status: 'ready',
        size: FILES.mp4.length,
        durationMs: 4200,
      });
      expect(ready.contentUrl).toBe(
        `/projects/${w.a}/attachments/${ready.attachmentId}/content`,
      );

      const attachment = await w.ctx.prisma.attachment.findUniqueOrThrow({
        where: { id: ready.attachmentId as string },
      });
      expect(attachment).toMatchObject({
        cardId: (await w.card(1)).id,
        mime: 'video/mp4',
        uploaderId: null,
        expiresAt: null,
        sha256: sha256(FILES.mp4),
      });

      const listed = (await w.viewer.get(demosUrl())).body as CardDemoView[];
      expect(listed[0]).toMatchObject({ id: demo.id, status: 'ready' });
      const played = await w.viewer
        .get(ready.contentUrl as string)
        .set('Range', 'bytes=0-3');
      expect(played.status).toBe(206);
      expect(played.headers['content-type']).toBe('video/mp4');

      const [record] = await w.audit('demo.video_uploaded');
      expect(record.after).toMatchObject({
        demoId: demo.id,
        attachmentId: ready.attachmentId,
      });

      // A finished demo takes no second video.
      const second = await video(demo.id, token, FILES.webm, {
        type: 'video/webm',
      });
      expect(second.status).toBe(409);
      expect(await w.ctx.prisma.attachment.count()).toBe(1);
    });

    it('is 415 without a bearer token, 401 for a bad one, 403 for a foreign runner', async () => {
      await ranCard();
      const demo = await requested();
      // No Authorization: a cross-site form, held by the JSON-only rule.
      expect((await video(demo.id, undefined)).status).toBe(415);
      expect((await video(demo.id, generateRunnerToken())).status).toBe(401);
      expect((await video(demo.id, await foreignToken())).status).toBe(403);
      expect(await w.ctx.prisma.attachment.count()).toBe(0);
      expect(
        (
          await w.ctx.prisma.cardDemo.findUniqueOrThrow({
            where: { id: demo.id },
          })
        ).status,
      ).toBe('queued');
    });

    it('is 422 when the body does not match its SHA-256, or is not an MP4 or WebM', async () => {
      await ranCard();
      const demo = await requested();
      const token = await tokenFor(w.runnerId);

      const mismatch = await video(demo.id, token, FILES.mp4, {
        sha: sha256(FILES.webm),
      });
      expect(mismatch.status).toBe(422);
      expect(mismatch.body.error).toBe('integrity_mismatch');

      const badSha = await video(demo.id, token, FILES.mp4, { sha: 'abc' });
      expect(badSha.status).toBe(422);

      for (const body of [FILES.png, FILES.mov]) {
        const refused = await video(demo.id, token, body);
        expect(refused.status).toBe(422);
        expect(refused.body.code).toBe('unsupported_type');
      }
      expect(await w.ctx.prisma.attachment.count()).toBe(0);

      // The demo is still open for the right video.
      expect(
        (await video(demo.id, token, FILES.webm, { type: 'video/webm' }))
          .status,
      ).toBe(201);
    });
  });

  describe('demo.status', () => {
    it('moves an active demo and ignores a late event', async () => {
      await ranCard();
      const demo = await requested();
      const cardId = (await w.card(1)).id;
      const status = (data: Record<string, unknown>) =>
        w.deliver('demo.status', {
          cardId,
          projectId: w.a,
          demoId: demo.id,
          at: new Date().toISOString(),
          ...data,
        });
      const row = () =>
        w.ctx.prisma.cardDemo.findUniqueOrThrow({ where: { id: demo.id } });

      await status({ status: 'recording' });
      expect(await row()).toMatchObject({ status: 'recording' });
      expect((await row()).startedAt).not.toBeNull();

      await status({ status: 'failed', reason: 'readyUrl never answered' });
      expect(await row()).toMatchObject({
        status: 'failed',
        reason: 'readyUrl never answered',
      });

      await status({ status: 'recording' });
      expect(await row()).toMatchObject({ status: 'failed' });

      // A failed demo is a warning: another may be asked for.
      expect((await w.operator.send('post', demosUrl())).status).toBe(201);
    });

    it('skips a malformed event', async () => {
      await ranCard();
      const demo = await requested();
      await w.deliver('demo.status', {
        cardId: (await w.card(1)).id,
        projectId: w.a,
        demoId: demo.id,
        status: 'failed',
        at: new Date().toISOString(),
      });
      expect(
        (
          await w.ctx.prisma.cardDemo.findUniqueOrThrow({
            where: { id: demo.id },
          })
        ).status,
      ).toBe('queued');
    });
  });
});
