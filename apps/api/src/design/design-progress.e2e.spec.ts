import type { PlanDetail, TaskDesignView } from '@agentdock/shared';
import { decomposed, task } from '../planner/testing/planner-e2e';
import {
  DesignHarness,
  designResult,
  profileResult,
} from './testing/design-e2e';

const TIMEOUT = 'the turn exceeded its 1200 s timeout';

/** #275 D1, D2, D6: progress, the job's clock and the last failure in the view. */
describe('design progress (e2e)', () => {
  const h = new DesignHarness();

  beforeAll(() => h.start());
  afterAll(() => h.ctx.app.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  const uiPlan = (variants = 1): Promise<PlanDetail> =>
    decomposed(h, [
      task('t1', { design: { needed: true, why: 'A screen.', variants } }),
    ]);

  const design = async (planId: string) =>
    (await h.author.get(h.designBase(planId, 't1'))).body as TaskDesignView;

  const generate = (planId: string) =>
    h.author.send('post', `${h.designBase(planId, 't1')}/generate`);

  it('a first Generate is step 1 while the profile builds, then step 2 per variant; busySince spans the job', async () => {
    const plan = await uiPlan(2);
    expect((await generate(plan.id)).status).toBe(201);
    const build = await h.activeBuild();

    const building = await design(plan.id);
    expect(building.busySince).not.toBeNull();
    expect(building.progress).toEqual({
      stage: 'profile',
      phase: 'running',
      runId: build.id,
      turnId: null,
      variant: null,
      variantCount: 2,
      step: 1,
      startedAt: building.busySince,
    });
    expect(building.lastFailure).toBeNull();

    await h.finishBuild(profileResult());
    const first = await h.activeTurn(plan.id);
    const drawing = await design(plan.id);
    expect(drawing.progress).toEqual({
      stage: 'draw',
      phase: 'queued',
      runId: first.runId,
      turnId: first.id,
      variant: 1,
      variantCount: 2,
      step: 2,
      startedAt: building.busySince,
    });
    expect(drawing.busySince).toBe(building.busySince);

    await h.finish(plan.id, designResult({ taskKey: 't1', variant: 1 }));
    const second = await h.activeTurn(plan.id);
    expect((await design(plan.id)).progress).toMatchObject({
      stage: 'draw',
      runId: second.runId,
      variant: 2,
      step: 2,
    });

    await h.finish(plan.id, designResult({ taskKey: 't1', variant: 2 }));
    const done = await design(plan.id);
    expect(done.status).toBe('reviewing');
    expect(done.busySince).toBeNull();
    expect(done.progress).toBeNull();
    expect(done.lastFailure).toBeNull();
  });

  it('a Generate with a ready profile has no step; a Revise is the revise stage', async () => {
    await h.seedProfile();
    const plan = await uiPlan();
    expect((await generate(plan.id)).status).toBe(201);
    const turn = await h.activeTurn(plan.id);
    const drawing = await design(plan.id);
    expect(drawing.progress).toMatchObject({
      stage: 'draw',
      runId: turn.runId,
      turnId: turn.id,
      variant: 1,
      step: null,
    });
    expect(drawing.activeTurnId).toBe(turn.id);

    await h.finish(plan.id, designResult({ taskKey: 't1', variant: 1 }));
    const [revision] = (await design(plan.id)).revisions;
    const comment = await h.author.send(
      'post',
      `${h.designBase(plan.id, 't1')}/comments`,
      { revisionId: revision.id, kind: 'general', body: 'Tighter.' },
    );
    expect(comment.status).toBe(201);
    const revise = await h.author.send(
      'post',
      `${h.designBase(plan.id, 't1')}/revise`,
    );
    expect(revise.status).toBe(201);
    expect((await design(plan.id)).progress).toMatchObject({
      stage: 'revise',
      variant: 1,
      step: null,
    });
  });

  it('a timed-out design turn leaves the design at rest with lastFailure timed_out; a new Generate clears it', async () => {
    await h.seedProfile();
    const plan = await uiPlan();
    expect((await generate(plan.id)).status).toBe(201);
    await h.endTurn(plan.id, 'failed', TIMEOUT);

    const failed = await design(plan.id);
    expect(failed.status).toBe('idle');
    expect(failed.busySince).toBeNull();
    expect(failed.progress).toBeNull();
    expect(failed.lastFailure).toMatchObject({
      stage: 'draw',
      mode: 'generate',
      reason: 'timed_out',
      message: TIMEOUT,
      variant: 1,
    });

    expect((await generate(plan.id)).status).toBe(201);
    const retrying = await design(plan.id);
    expect(retrying.lastFailure).toBeNull();
    expect(retrying.progress).toMatchObject({ stage: 'draw' });
    await h.finish(plan.id, designResult({ taskKey: 't1', variant: 1 }));
    expect((await design(plan.id)).lastFailure).toBeNull();
  });

  it("the plan page's Retry of a failed design turn restarts the job's clock", async () => {
    await h.seedProfile();
    const plan = await uiPlan();
    expect((await generate(plan.id)).status).toBe(201);
    const failed = await h.activeTurn(plan.id);
    await h.endTurn(plan.id, 'failed', TIMEOUT);
    expect((await design(plan.id)).busySince).toBeNull();

    const retried = await h.author.send(
      'post',
      `${h.base(plan.id)}/turns/${failed.id}/retry`,
    );
    expect(retried.status).toBeLessThan(300);
    const busy = await design(plan.id);
    expect(busy.status).toBe('generating');
    expect(busy.busySince).not.toBeNull();
    expect(busy.progress).toMatchObject({ stage: 'draw', variant: 1 });
  });

  it('a failed build leaves the design idle with lastFailure on the profile stage', async () => {
    const plan = await uiPlan();
    expect((await generate(plan.id)).status).toBe(201);
    await h.endBuild('failed', 'claude exited 1');

    const failed = await design(plan.id);
    expect(failed.status).toBe('idle');
    expect(failed.busySince).toBeNull();
    expect(failed.lastFailure).toMatchObject({
      stage: 'profile',
      mode: 'generate',
      reason: 'failed',
      message: 'claude exited 1',
      variant: null,
    });
  });
});
