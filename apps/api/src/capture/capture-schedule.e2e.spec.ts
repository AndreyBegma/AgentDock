import {
  CAPTURE_IDLE_DELAY_MS,
  CAPTURE_SESSION_END_DELAY_MS,
  captureJobId,
} from '@nautelle/shared';
import { CaptureWorker } from './capture-worker';
import { CaptureWorld, LONG_PROMPT } from './testing/capture-e2e';

const SETTINGS = { issueOnRun: false, specOnRun: false, maxRunning: 3 };

describe('card capture scheduling (e2e)', () => {
  const w = new CaptureWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  const jobOf = (sessionId: string) => w.queue.getJob(captureJobId(sessionId));

  describe('D1: what is captured', () => {
    it('schedules nothing while the project ships no content', async () => {
      await w.contentOn(false);
      const id = await w.manualSession();
      await w.stopped('m1');
      expect(await jobOf(id)).toBeUndefined();
    });

    it('schedules nothing while capture is off', async () => {
      await w.ctx.prisma.boardSettings.update({
        where: { projectId: w.a },
        data: { captureEnabled: false },
      });
      const id = await w.manualSession();
      await w.stopped('m1');
      await w.hook('hook.session_ended', 'm1', { reason: 'other' });
      expect(await jobOf(id)).toBeUndefined();
    });

    it('schedules nothing for a session that is not manual', async () => {
      const id = await w.manualSession();
      await w.ctx.prisma.agentSession.update({
        where: { id },
        data: { origin: 'run' },
      });
      await w.stopped('m1');
      expect(
        (await w.ctx.prisma.agentSession.findUniqueOrThrow({ where: { id } }))
          .origin,
      ).toBe('run');
      expect(await jobOf(id)).toBeUndefined();
      expect(await w.queue.getDelayedCount()).toBe(0);
    });

    it('does not extract once content is turned off after scheduling', async () => {
      const id = await w.manualSession();
      await w.prompt('m1', LONG_PROMPT);
      await w.contentOn(false);
      const outcome = await w.capture.extract({ sessionId: id });
      expect(outcome).toMatchObject({ kind: 'skipped', reason: 'capture_off' });
      expect(w.extracted()).toEqual([]);
    });
  });

  describe('D10: the switch', () => {
    it('refuses capture without content with 422 capture_needs_content', async () => {
      await w.ctx.prisma.boardSettings.update({
        where: { projectId: w.a },
        data: { captureEnabled: false },
      });
      await w.contentOn(false);
      const refused = await w.admin.send('put', `${w.path()}/board-settings`, {
        ...SETTINGS,
        captureEnabled: true,
      });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('capture_needs_content');

      await w.contentOn(true);
      const allowed = await w.admin.send('put', `${w.path()}/board-settings`, {
        ...SETTINGS,
        captureEnabled: true,
        captureModel: 'sonnet',
      });
      expect(allowed.status).toBe(200);
      expect(allowed.body).toMatchObject({
        captureEnabled: true,
        captureModel: 'sonnet',
      });
      const [audit] = await w.audit('board.settings_updated');
      expect(audit.after).toMatchObject({
        captureEnabled: true,
        captureModel: 'sonnet',
      });
    });

    it('turning content off turns capture off, and it stays off after', async () => {
      const off = await w.admin.send('patch', w.path(), {
        shipSessionContent: false,
      });
      expect(off.status).toBe(200);
      const settings = await w.admin.get(`${w.path()}/board-settings`);
      expect(settings.body.captureEnabled).toBe(false);

      // Content back on does not bring capture back by itself.
      await w.admin.send('patch', w.path(), { shipSessionContent: true });
      expect(
        (await w.admin.get(`${w.path()}/board-settings`)).body.captureEnabled,
      ).toBe(false);
      const id = await w.manualSession();
      await w.stopped('m1');
      expect(await jobOf(id)).toBeUndefined();
    });

    it('refuses a model outside the allowed ones', async () => {
      const response = await w.admin.send('put', `${w.path()}/board-settings`, {
        ...SETTINGS,
        captureModel: 'opus',
      });
      expect(response.status).toBe(400);
    });
  });

  describe('D2: triggers', () => {
    it('debounces three hook.stopped into one delayed job', async () => {
      const id = await w.manualSession();
      await w.stopped('m1');
      await w.stopped('m1');
      await w.stopped('m1');
      expect(await w.queue.getDelayedCount()).toBe(1);
      const job = await jobOf(id);
      expect(job?.data).toEqual({ sessionId: id });
      expect(job?.delay).toBe(CAPTURE_IDLE_DELAY_MS);
      expect(await job?.getState()).toBe('delayed');
    });

    it('runs one extraction 2 minutes after hook.session_ended', async () => {
      const id = await w.manualSession();
      await w.prompt('m1', LONG_PROMPT);
      await w.stopped('m1', 'Noted: the redirect loop and the timezone bug.');
      await w.hook('hook.session_ended', 'm1', { reason: 'other' });

      expect(await w.queue.getDelayedCount()).toBe(1);
      const job = await jobOf(id);
      expect(job?.delay).toBe(CAPTURE_SESSION_END_DELAY_MS);

      // The worker's own step, on the job the queue holds.
      const worker = w.ctx.app.get(CaptureWorker);
      if (!job) throw new Error('no job');
      const outcome = await worker.process(job);
      expect(outcome).toMatchObject({ kind: 'started' });
      expect(w.extracted()).toHaveLength(1);
      expect(w.extracted()[0]).toMatchObject({
        projectId: w.a,
        profileKey: 'claude-main',
        model: 'haiku',
        timeoutSec: 180,
      });
      const [capture] = await w.captures(id);
      expect(capture).toMatchObject({ status: 'running', sessionId: id });
    });
  });
});
