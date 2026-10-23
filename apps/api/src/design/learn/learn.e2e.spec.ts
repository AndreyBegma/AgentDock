import {
  type TaskDesignView,
  type UiProfileView,
  uiProfileLearnJobId,
} from '@nautelle/shared';
import type { UiProfileLearnArgs } from '@nautelle/shared/protocol';
import { CardDesignHarness } from '../testing/card-design-e2e';
import { designResult, profileResult } from '../testing/design-e2e';
import { type LearnSendResult, UiProfileLearnCommands } from './learn-commands';
import { UiProfileLearnQueue } from './learn-queue';
import { UiProfileLearner } from './ui-profile-learner';

const LEGIT_SNIPPET = '<div class="plan-card">Pro plan</div>';

const answer = (commentId: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    screen: {
      name: 'Login',
      summary: 'A centred card with the form and the primary action below.',
      snippetsUsed: ['card', 'not-a-snippet'],
    },
    styleRules: [
      {
        text: 'Primary actions sit bottom-right.',
        commentIds: [commentId, 'x'],
      },
    ],
    newSnippets: [{ name: 'plan-card', html: LEGIT_SNIPPET }],
    ...over,
  });

describe('UI profile memory (e2e, #752)', () => {
  const h = new CardDesignHarness();
  let learner: UiProfileLearner;
  let queue: UiProfileLearnQueue;
  let learnCommands: UiProfileLearnCommands;
  let reply: (args: UiProfileLearnArgs) => LearnSendResult;
  let sent: UiProfileLearnArgs[];
  let state: 'ready' | 'offline' | 'unsupported';

  beforeAll(async () => {
    await h.start();
    learner = h.ctx.app.get(UiProfileLearner);
    queue = h.ctx.app.get(UiProfileLearnQueue);
    learnCommands = h.ctx.app.get(UiProfileLearnCommands);
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    sent = [];
    state = 'ready';
    reply = () => ({
      status: 'error',
      message: 'internal — no reply set',
    });
    jest.spyOn(learnCommands, 'state').mockImplementation(() => state);
    jest
      .spyOn(learnCommands, 'learn')
      .mockImplementation(async (_runner, args) => {
        sent.push(args);
        return reply(args);
      });
  });
  afterEach(() => jest.restoreAllMocks());

  const profileView = async () =>
    (await h.viewer.get(`/projects/${h.projectId}/ui-profile`))
      .body as UiProfileView;

  /** A card with an approved design and one comment on it. */
  const approvedCard = async (title = 'Add login') => {
    const card = await h.createCard({ title });
    await h.author.send('patch', h.cardDesignBase(card.number), {
      needed: true,
      variantCount: 1,
    });
    expect(
      (await h.author.send('post', `${h.cardDesignBase(card.number)}/generate`))
        .status,
    ).toBe(201);
    await h.finishCard(
      card.id,
      designResult({ taskKey: `card-${card.number}`, variant: 1 }),
    );
    const view = await h.cardDesign(card.number);
    const revision = view.revisions[0];
    if (!revision) throw new Error('no revision');
    const comment = await h.author.send(
      'post',
      `${h.cardDesignBase(card.number)}/comments`,
      {
        revisionId: revision.id,
        kind: 'general',
        body: 'Put the primary button bottom-right.',
      },
    );
    expect(comment.status).toBe(201);
    const approved = await h.author.send(
      'post',
      `${h.cardDesignBase(card.number)}/approve`,
      { revisionId: revision.id },
    );
    expect(approved.status).toBe(200);
    const design = approved.body as TaskDesignView;
    const stored = await h.ctx.prisma.designComment.findFirstOrThrow({
      where: { designId: design.id },
    });
    return { card, design, revisionId: revision.id, commentId: stored.id };
  };

  const learnOf = (designId: string, revisionId: string) =>
    learner.process({ designId, revisionId });

  it('approving a card design enqueues exactly one learn; a valid answer writes one memory version', async () => {
    await h.seedProfile();
    const { design, revisionId, commentId } = await approvedCard();

    const job = await queue.queue?.getJob(uiProfileLearnJobId(revisionId));
    expect(job?.data).toEqual({ designId: design.id, revisionId });
    // A second request of the same approval is the same job.
    await learner.request(design.id, revisionId);
    const jobs = (await queue.queue?.getJobs(['waiting', 'delayed'])) ?? [];
    const same = jobs.filter((j) => j.data.revisionId === revisionId);
    expect(same).toHaveLength(1);

    reply = () => ({
      status: 'ok',
      output: { resultText: answer(commentId), resultTruncated: false },
    });
    const outcome = await learnOf(design.id, revisionId);
    expect(outcome.kind).toBe('learned');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ model: 'sonnet', projectId: h.projectId });
    expect(sent[0].prompt).toContain('Put the primary button bottom-right.');
    expect(sent[0].prompt).toContain(commentId);

    const view = await profileView();
    expect(view.current).toMatchObject({
      version: 2,
      source: 'memory',
      summary: 'SEEDED SUMMARY',
      learnedFromRevisionId: revisionId,
      learnNotes: null,
    });
    expect(view.current?.screens).toEqual([
      expect.objectContaining({
        designId: design.id,
        revisionId,
        name: 'Login',
        // Only names the profile has.
        snippetsUsed: ['card'],
      }),
    ]);
    expect(view.current?.styleRules).toEqual([
      {
        text: 'Primary actions sit bottom-right.',
        commentIds: [commentId],
        designId: design.id,
      },
    ]);
    expect(view.current?.snippets.map((s) => s.name)).toEqual([
      'card',
      'plan-card',
    ]);
    const run = await h.ctx.prisma.run.findFirstOrThrow({
      where: { kind: 'ui_profile_learn' },
    });
    expect(run).toMatchObject({ status: 'succeeded', model: 'sonnet' });
  });

  it('drops a snippet that fails the mockup rules or reuses a name, lists it in learnNotes, and still stores the version', async () => {
    await h.seedProfile();
    const { design, revisionId, commentId } = await approvedCard();
    reply = () => ({
      status: 'ok',
      output: {
        resultText: answer(commentId, {
          newSnippets: [
            { name: 'card', html: '<div>dup</div>' },
            {
              name: 'evil',
              html: '<script>location.href = "https://evil.test"</script>',
            },
            { name: 'plan-card', html: LEGIT_SNIPPET },
          ],
        }),
        resultTruncated: false,
      },
    });
    expect((await learnOf(design.id, revisionId)).kind).toBe('learned');
    const view = await profileView();
    expect(view.current?.snippets.map((s) => s.name)).toEqual([
      'card',
      'plan-card',
    ]);
    expect(view.current?.learnNotes).toContain(
      '`card` dropped: the name is taken',
    );
    expect(view.current?.learnNotes).toContain('`evil` dropped');
  });

  it('a failed or out-of-contract learn leaves the profile unchanged; the approval already succeeded', async () => {
    await h.seedProfile();
    const { card, design, revisionId } = await approvedCard();
    for (const next of [
      (): LearnSendResult => ({ status: 'error', message: 'internal — boom' }),
      (): LearnSendResult => ({
        status: 'ok',
        output: { resultText: 'Sure! Here you go.', resultTruncated: false },
      }),
      (): LearnSendResult => ({
        status: 'ok',
        output: { resultText: '{"screen"', resultTruncated: true },
      }),
    ]) {
      reply = next;
      expect((await learnOf(design.id, revisionId)).kind).toBe('failed');
    }
    expect((await profileView()).current?.version).toBe(1);
    const runs = await h.ctx.prisma.run.findMany({
      where: { kind: 'ui_profile_learn' },
    });
    expect(runs.map((r) => r.status)).toEqual(['failed', 'failed', 'failed']);
    expect((await h.cardDesign(card.number)).status).toBe('approved');
  });

  it('a runner without uiProfileLearn gets no uiprofile.learn, and the approval succeeds', async () => {
    await h.seedProfile();
    state = 'unsupported';
    const { card, design, revisionId } = await approvedCard();
    expect((await learnOf(design.id, revisionId)).kind).toBe('skipped');
    expect(sent).toHaveLength(0);
    expect(
      await h.ctx.prisma.run.count({ where: { kind: 'ui_profile_learn' } }),
    ).toBe(0);
    expect((await h.cardDesign(card.number)).status).toBe('approved');
  });

  it('two approvals learned at once give two consecutive versions', async () => {
    await h.seedProfile();
    const a = await approvedCard('Add login');
    const b = await approvedCard('Add billing');
    reply = (args) => ({
      status: 'ok',
      output: {
        resultText: answer(
          args.prompt.includes(a.commentId) ? a.commentId : b.commentId,
          { newSnippets: [] },
        ),
        resultTruncated: false,
      },
    });
    const outcomes = await Promise.all([
      learnOf(a.design.id, a.revisionId),
      learnOf(b.design.id, b.revisionId),
    ]);
    expect(outcomes.map((o) => o.kind)).toEqual(['learned', 'learned']);
    const versions = await h.ctx.prisma.uiProfile.findMany({
      where: { projectId: h.projectId },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((v) => [v.version, v.source])).toEqual([
      [1, 'agent'],
      [2, 'memory'],
      [3, 'memory'],
    ]);
    // The second writes on top of the first: both screens, newest first.
    expect((versions[2].screens as unknown[]).length).toBe(2);
  });

  it('an agent rebuild after a memory version keeps its rules and snippets as obligations, and carries screens and styleRules', async () => {
    await h.seedProfile();
    const { revisionId, design, commentId } = await approvedCard();
    reply = () => ({
      status: 'ok',
      output: { resultText: answer(commentId), resultTruncated: false },
    });
    await learnOf(design.id, revisionId);

    expect(
      (
        await h.author.send(
          'post',
          `/projects/${h.projectId}/ui-profile/rebuild`,
        )
      ).status,
    ).toBe(201);
    const [build] = h.designSent('uiprofile.build');
    expect(String(build.prompt)).toContain('learned from an approved design');
    expect(String(build.prompt)).toContain(
      'Style rule: Primary actions sit bottom-right.',
    );
    expect(String(build.prompt)).toContain('Snippet `plan-card` reads:');
    await h.finishBuild(profileResult());

    const view = await profileView();
    expect(view.current).toMatchObject({ version: 3, source: 'agent' });
    expect(view.current?.screens).toHaveLength(1);
    expect(view.current?.styleRules).toHaveLength(1);
  });

  it('with useMemory on the design prompt has both sections; off, neither — and learning still stores', async () => {
    await h.seedProfile();
    const { design, revisionId, commentId } = await approvedCard();
    reply = () => ({
      status: 'ok',
      output: { resultText: answer(commentId), resultTruncated: false },
    });
    await learnOf(design.id, revisionId);

    const next = await h.designedCard(1);
    await h.author.send('post', `${h.cardDesignBase(next.number)}/generate`);
    const on = h.turnPrompts().at(-1) ?? '';
    expect(on).toContain('### Approved screens');
    expect(on).toContain('### Style rules');
    expect(on).toContain('Primary actions sit bottom-right.');
    expect(on.indexOf('### Component snippets')).toBeLessThan(
      on.indexOf('### Approved screens'),
    );
    await h.finishCard(
      next.id,
      designResult({ taskKey: `card-${next.number}`, variant: 1 }),
    );

    const off = await h.admin.send(
      'put',
      `/projects/${h.projectId}/design-settings`,
      {
        viewports: [{ name: 'Desktop', width: 1440, height: 900 }],
        defaultSkills: [],
        useMemory: false,
      },
    );
    expect(off.status).toBe(200);
    expect(off.body.useMemory).toBe(false);
    const third = await h.designedCard(1);
    await h.author.send('post', `${h.cardDesignBase(third.number)}/generate`);
    const without = h.turnPrompts().at(-1) ?? '';
    expect(without).not.toContain('### Approved screens');
    expect(without).not.toContain('### Style rules');

    // Learning does not depend on the switch.
    await h.finishCard(
      third.id,
      designResult({ taskKey: `card-${third.number}`, variant: 1 }),
    );
    const view = await h.cardDesign(third.number);
    await h.author.send('post', `${h.cardDesignBase(third.number)}/approve`, {
      revisionId: view.revisions[0]?.id,
    });
    const learned = await learnOf(view.id, view.revisions[0]?.id ?? '');
    expect(learned.kind).toBe('learned');
  });

  it('authorization: a viewer reads the library, an outsider gets 404, a non-admin cannot edit it or useMemory', async () => {
    await h.seedProfile();
    const { design, revisionId, commentId } = await approvedCard();
    reply = () => ({
      status: 'ok',
      output: { resultText: answer(commentId), resultTruncated: false },
    });
    await learnOf(design.id, revisionId);

    const viewer = await h.viewer.get(`/projects/${h.projectId}/ui-profile`);
    expect(viewer.status).toBe(200);
    expect(viewer.body.current.screens).toHaveLength(1);
    expect(
      (await h.outsider.get(`/projects/${h.projectId}/ui-profile`)).status,
    ).toBe(404);

    const current = (await profileView()).current;
    if (!current) throw new Error('no profile');
    const edit = {
      summary: current.summary,
      kit: current.kit,
      snippets: current.snippets,
      screens: [],
      styleRules: [
        { text: 'Use sentence case.', commentIds: [], designId: null },
      ],
    };
    expect(
      (await h.author.send('put', `/projects/${h.projectId}/ui-profile`, edit))
        .status,
    ).toBe(403);
    expect(
      (
        await h.author.send('put', `/projects/${h.projectId}/design-settings`, {
          viewports: [{ name: 'Desktop', width: 1440, height: 900 }],
          defaultSkills: [],
          useMemory: false,
        })
      ).status,
    ).toBe(403);

    // A5: an admin deletes the library entry and rewrites the rules.
    const saved = await h.admin.send(
      'put',
      `/projects/${h.projectId}/ui-profile`,
      edit,
    );
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      source: 'manual',
      screens: [],
      styleRules: [{ text: 'Use sentence case.', designId: null }],
    });
    // Left out, they carry forward.
    const kept = await h.admin.send(
      'put',
      `/projects/${h.projectId}/ui-profile`,
      {
        summary: current.summary,
        kit: current.kit,
        snippets: current.snippets,
      },
    );
    expect(kept.body.styleRules).toEqual([
      { text: 'Use sentence case.', commentIds: [], designId: null },
    ]);
  });
});
