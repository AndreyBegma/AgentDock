import {
  REVIEW_ERROR,
  type ReviewSettingsUpdateResult,
  type ReviewSettingsView,
  type ReviewStepView,
} from '@nautelle/shared';
import { seedProject } from '../fleet/testing/fleet-e2e';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import {
  DEFAULT_PEER_REVIEW_INSTRUCTIONS,
  PeerReviewGenerator,
} from './peer-review-generator';
import { reviewError } from './review-error';

const ROOT_A = '/srv/dev/widget';
const ROOT_B = '/srv/dev/gadget';
const GENERATED = '# Peer review\n\nUse Bun, Biome and the ADRs.\n';

describe('project review steps (e2e, #862)', () => {
  let ctx: E2eContext;
  let generate: jest.SpyInstance;
  let runnerId: string;
  let a: string;
  let b: string;
  let admin: Session;
  let operatorOfA: Session;
  let viewerOfA: Session;

  const memberOf = async (
    email: string,
    projectId: string,
    role: 'viewer' | 'operator',
  ) => {
    const user = await createUser(ctx.prisma, email, role);
    await ctx.prisma.projectMember.create({
      data: { projectId, userId: user.id },
    });
    return login(ctx, email);
  };

  const path = (projectId = a, rest = '') =>
    `/projects/${projectId}/review${rest}`;

  /** A skill the runner reported for project `a`. */
  const installSkill = (invocation: string, projectId = a) =>
    ctx.prisma.installedSkill.create({
      data: {
        runnerId,
        projectId,
        scope: 'project',
        runtime: 'claude',
        name: invocation,
        invocation,
        path: `${ROOT_A}/.claude/skills/${invocation}/SKILL.md`,
        seenAt: new Date(),
      },
    });

  const enable = async () => {
    const response = await admin.send('put', path(), { reviewEnabled: true });
    expect(response.status).toBe(200);
    return response.body as ReviewSettingsUpdateResult;
  };

  const addSkill = async (name: string, skillName: string) => {
    const response = await admin.send('post', path(a, '/steps'), {
      name,
      skillName,
    });
    expect(response.status).toBe(201);
    return response.body as ReviewStepView;
  };

  beforeAll(async () => {
    ctx = await createE2eApp();
    generate = jest.spyOn(ctx.app.get(PeerReviewGenerator), 'generate');
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    generate.mockReset();
    generate.mockResolvedValue(GENERATED);
    await resetDatabase(ctx.prisma);
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE runners, projects CASCADE',
    );
    ({ runnerId, projectId: a } = await seedProject(ctx.prisma, ROOT_A));
    ({ projectId: b } = await seedProject(ctx.prisma, ROOT_B, runnerId));
    await createUser(ctx.prisma, 'admin@example.com', 'admin');
    admin = await login(ctx, 'admin@example.com');
    operatorOfA = await memberOf('operator@example.com', a, 'operator');
    viewerOfA = await memberOf('viewer@example.com', a, 'viewer');
  });

  it('is off, with no steps, for a project nobody configured', async () => {
    const response = await viewerOfA.get(path());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      projectId: a,
      reviewEnabled: false,
      publishReviewComments: false,
      steps: [],
    } satisfies ReviewSettingsView);
  });

  it('keeps an existing board settings row off', async () => {
    await ctx.prisma.boardSettings.create({
      data: { projectId: a, autoMergeCards: true },
    });
    const row = await ctx.prisma.boardSettings.findUniqueOrThrow({
      where: { projectId: a },
    });
    expect(row.reviewEnabled).toBe(false);
    expect(row.publishReviewComments).toBe(false);
  });

  it('creates one generated peer review step on first enable, never a second', async () => {
    const first = await enable();
    expect(first.reviewEnabled).toBe(true);
    expect(first.publishReviewComments).toBe(false);
    expect(first.generationError).toBeNull();
    expect(first.steps).toHaveLength(1);
    expect(first.steps[0]).toMatchObject({
      type: 'peer_review',
      name: 'Peer review',
      position: 0,
      enabled: true,
      instructions: GENERATED,
      skillName: null,
      instructionsEditedAt: null,
    });
    expect(first.steps[0]?.instructionsGeneratedAt).not.toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toBe(a);

    await admin.send('put', path(), { reviewEnabled: false });
    const again = await enable();
    expect(again.steps).toHaveLength(1);
    expect(again.steps[0]?.id).toBe(first.steps[0]?.id);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(
      await ctx.prisma.projectReviewStep.count({
        where: { projectId: a, type: 'peer_review' },
      }),
    ).toBe(1);
  });

  it('stores the default instructions when the first generation fails', async () => {
    generate.mockRejectedValueOnce(
      reviewError(409, REVIEW_ERROR.runnerOffline, 'The runner is offline'),
    );
    const result = await enable();
    expect(result.reviewEnabled).toBe(true);
    expect(result.generationError).toEqual({
      code: REVIEW_ERROR.runnerOffline,
      message: 'The runner is offline',
    });
    expect(result.steps[0]).toMatchObject({
      type: 'peer_review',
      instructions: DEFAULT_PEER_REVIEW_INSTRUCTIONS,
      instructionsGeneratedAt: null,
    });
  });

  it('allows one peer review step per project in the database', async () => {
    await enable();
    await expect(
      ctx.prisma.projectReviewStep.create({
        data: {
          projectId: a,
          type: 'peer_review',
          name: 'Another',
          position: 1,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('turns publishing comments on and off without touching review', async () => {
    const on = await admin.send('put', path(), { publishReviewComments: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({
      reviewEnabled: false,
      publishReviewComments: true,
      steps: [],
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('regenerates the peer review instructions, replacing edits', async () => {
    const [peer] = (await enable()).steps;
    await admin.send('patch', path(a, `/steps/${peer?.id}`), {
      instructions: 'Edited.',
    });
    generate.mockResolvedValueOnce('# Peer review\n\nFresh.');

    const response = await admin.send(
      'post',
      path(a, '/peer-review/regenerate'),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: peer?.id,
      instructions: '# Peer review\n\nFresh.',
    });
    expect((response.body as ReviewStepView).instructionsGeneratedAt).not.toBe(
      peer?.instructionsGeneratedAt,
    );
  });

  it('keeps the instructions when a regeneration fails', async () => {
    const [peer] = (await enable()).steps;
    generate.mockRejectedValueOnce(
      reviewError(409, REVIEW_ERROR.noModel, 'No default AI model is set'),
    );
    const response = await admin.send(
      'post',
      path(a, '/peer-review/regenerate'),
    );
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: REVIEW_ERROR.noModel });
    const row = await ctx.prisma.projectReviewStep.findUniqueOrThrow({
      where: { id: peer?.id },
    });
    expect(row.instructions).toBe(GENERATED);
  });

  it('refuses to regenerate before review was ever enabled', async () => {
    const response = await admin.send(
      'post',
      path(a, '/peer-review/regenerate'),
    );
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: REVIEW_ERROR.noPeerReview });
    expect(generate).not.toHaveBeenCalled();
  });

  it('stores edited instructions exactly as sent', async () => {
    const [peer] = (await enable()).steps;
    const text = '  # Review\n\n- Keep **ADRs**.\n\n\ttabbed line  \n';
    const response = await admin.send('patch', path(a, `/steps/${peer?.id}`), {
      instructions: text,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ instructions: text });
    expect(
      (response.body as ReviewStepView).instructionsEditedAt,
    ).not.toBeNull();

    const read = await viewerOfA.get(path());
    expect((read.body as ReviewSettingsView).steps[0]?.instructions).toBe(text);
  });

  it('adds, reorders, disables and deletes skill steps', async () => {
    await installSkill('cs-security');
    await installSkill('cs-perf');
    const [peer] = (await enable()).steps;
    const security = await addSkill('Security', 'cs-security');
    const perf = await addSkill('Performance', 'cs-perf');
    expect(security).toMatchObject({
      type: 'skill',
      skillName: 'cs-security',
      instructions: null,
      enabled: true,
      position: 1,
    });
    expect(perf.position).toBe(2);

    const reordered = await admin.send('put', path(a, '/steps/order'), {
      stepIds: [perf.id, peer?.id, security.id],
    });
    expect(reordered.status).toBe(200);
    expect(
      (reordered.body as ReviewStepView[]).map((s) => [s.id, s.position]),
    ).toEqual([
      [perf.id, 0],
      [peer?.id, 1],
      [security.id, 2],
    ]);

    const disabled = await admin.send(
      'patch',
      path(a, `/steps/${security.id}`),
      { enabled: false, skillName: 'cs-perf' },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({
      enabled: false,
      skillName: 'cs-perf',
    });

    const removed = await admin.send('delete', path(a, `/steps/${perf.id}`));
    expect(removed.status).toBe(204);
    const after = (await viewerOfA.get(path())).body as ReviewSettingsView;
    expect(after.steps.map((s) => [s.id, s.position])).toEqual([
      [peer?.id, 0],
      [security.id, 1],
    ]);
  });

  it('puts the peer review step first when skill steps already exist', async () => {
    await installSkill('cs-security');
    const security = await addSkill('Security', 'cs-security');
    const { steps } = await enable();
    expect(steps.map((s) => [s.type, s.position])).toEqual([
      ['peer_review', 0],
      ['skill', 1],
    ]);
    expect(steps[1]?.id).toBe(security.id);
  });

  it('refuses a skill the runner does not report (400)', async () => {
    await installSkill('cs-security', b);
    const created = await admin.send('post', path(a, '/steps'), {
      name: 'Security',
      skillName: 'cs-security',
    });
    expect(created.status).toBe(400);
    expect(created.body).toMatchObject({ error: REVIEW_ERROR.unknownSkill });

    await installSkill('cs-perf');
    const step = await addSkill('Performance', 'cs-perf');
    const patched = await admin.send('patch', path(a, `/steps/${step.id}`), {
      skillName: 'cs-nope',
    });
    expect(patched.status).toBe(400);
    expect(patched.body).toMatchObject({ error: REVIEW_ERROR.unknownSkill });
  });

  it('never deletes the peer review step (409) but disables it', async () => {
    const [peer] = (await enable()).steps;
    const removed = await admin.send('delete', path(a, `/steps/${peer?.id}`));
    expect(removed.status).toBe(409);
    expect(removed.body).toMatchObject({ error: REVIEW_ERROR.builtinStep });

    const disabled = await admin.send('patch', path(a, `/steps/${peer?.id}`), {
      enabled: false,
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ enabled: false });
  });

  it('keeps each field to its step type', async () => {
    await installSkill('cs-security');
    const [peer] = (await enable()).steps;
    const skill = await addSkill('Security', 'cs-security');

    const onPeer = await admin.send('patch', path(a, `/steps/${peer?.id}`), {
      skillName: 'cs-security',
    });
    expect(onPeer.status).toBe(400);
    expect(onPeer.body).toMatchObject({ error: REVIEW_ERROR.wrongType });

    const onSkill = await admin.send('patch', path(a, `/steps/${skill.id}`), {
      instructions: 'Nope.',
    });
    expect(onSkill.status).toBe(400);
    expect(onSkill.body).toMatchObject({ error: REVIEW_ERROR.wrongType });
  });

  it('refuses an order that does not list every step once (409)', async () => {
    await installSkill('cs-security');
    const [peer] = (await enable()).steps;
    await addSkill('Security', 'cs-security');
    const response = await admin.send('put', path(a, '/steps/order'), {
      stepIds: [peer?.id],
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: REVIEW_ERROR.orderMismatch });
  });

  it('validates bodies', async () => {
    const unknown = await admin.send('put', path(), { reviewEnabled: 'yes' });
    expect(unknown.status).toBe(400);
    const extra = await admin.send('put', path(), { autoMergeCards: true });
    expect(extra.status).toBe(400);
    const noName = await admin.send('post', path(a, '/steps'), {
      name: '  ',
      skillName: 'cs-security',
    });
    expect(noName.status).toBe(400);
    const peerType = await admin.send('post', path(a, '/steps'), {
      name: 'Peer',
      skillName: 'cs-security',
      type: 'peer_review',
    });
    expect(peerType.status).toBe(400);
  });

  it('does not reach another project’s step', async () => {
    await installSkill('cs-security');
    const step = await addSkill('Security', 'cs-security');
    const response = await admin.send('patch', path(b, `/steps/${step.id}`), {
      enabled: false,
    });
    expect(response.status).toBe(404);
  });

  it('lets members read and only project admins write', async () => {
    expect((await viewerOfA.get(path())).status).toBe(200);
    expect((await operatorOfA.get(path())).status).toBe(200);
    expect(
      (await operatorOfA.send('put', path(), { reviewEnabled: true })).status,
    ).toBe(403);
    expect(
      (await viewerOfA.send('post', path(a, '/peer-review/regenerate'))).status,
    ).toBe(403);
    expect((await viewerOfA.get(path(b))).status).toBe(404);
    expect(generate).not.toHaveBeenCalled();
  });
});
