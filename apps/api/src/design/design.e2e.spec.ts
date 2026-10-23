import {
  CSRF_COOKIE,
  MOCKUP_PIN_HELPER_ATTRIBUTE,
  type PlanDetail,
  SESSION_COOKIE,
  type TaskDesignView,
  type UiProfileView,
} from '@nautelle/shared';
import { PLAN_TURN_RESULT_MAX_BYTES } from '@nautelle/shared/protocol';
import { BudgetGate } from '../budgets';
import { BudgetExceededError } from '../budgets/budget-error';
import { block, decomposed, task } from '../planner/testing/planner-e2e';
import {
  DesignHarness,
  designResult,
  hash,
  MOCKUP,
  profileResult,
} from './testing/design-e2e';

const FEATURE_DOC =
  '## Summary\n\nExport.\n\n## Acceptance criteria\n\n- [ ] works\n';

const ui = (variants = 1) => ({
  design: { needed: true, why: 'A new screen.', variants },
});

describe('design stage (e2e)', () => {
  const h = new DesignHarness();

  beforeAll(() => h.start());
  afterAll(() => h.ctx.app.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  /** A plan whose `t1` needs a design with `variants`, and `t2` none. */
  const uiPlan = (variants = 1): Promise<PlanDetail> =>
    decomposed(h, [task('t1', ui(variants)), task('t2')]);

  const design = async (planId: string, key = 't1') =>
    (await h.author.get(h.designBase(planId, key))).body as TaskDesignView;

  const generate = (planId: string, key = 't1') =>
    h.author.send('post', `${h.designBase(planId, key)}/generate`);

  /** Generate with a fresh profile and draw `variants` first revisions. */
  const drawn = async (variants = 1): Promise<PlanDetail> => {
    await h.seedProfile();
    const plan = await uiPlan(variants);
    expect((await generate(plan.id)).status).toBe(201);
    for (let v = 1; v <= variants; v += 1) {
      await h.finish(plan.id, designResult({ taskKey: 't1', variant: v }));
    }
    return plan;
  };

  it('suggests a design on decompose, holds the task in needs_design, and approving the design chains one write', async () => {
    await h.seedProfile();
    const plan = await uiPlan();
    const t1 = plan.tasks.find((t) => t.key === 't1');
    expect(t1).toMatchObject({
      status: 'needs_design',
      design: {
        needed: true,
        suggested: true,
        suggestionWhy: 'A new screen.',
        variantCount: 1,
        status: 'idle',
      },
    });
    expect(plan.tasks.find((t) => t.key === 't2')).toMatchObject({
      status: 'ready',
      design: null,
    });

    const refused = await h.author.send(
      'post',
      `${h.base(plan.id)}/tasks/t1/review`,
      { decision: 'approve' },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('design_not_approved');
    expect(
      (await h.auditOf('plan.task_reviewed')).map((r) => r.result),
    ).toEqual(['denied']);

    expect((await generate(plan.id)).status).toBe(201);
    expect(h.designSent('uiprofile.build')).toHaveLength(0);
    await h.finish(plan.id, designResult({ taskKey: 't1', variant: 1 }));
    const drawnDesign = await design(plan.id);
    expect(drawnDesign.status).toBe('reviewing');
    expect(drawnDesign.revisions).toHaveLength(1);
    const [revision] = drawnDesign.revisions;
    expect(revision.htmlUrl).toBe(`/api/design-revisions/${revision.id}/html`);

    const approved = await h.author.send(
      'post',
      `${h.designBase(plan.id, 't1')}/approve`,
      { revisionId: revision.id },
    );
    expect(approved.status).toBe(200);
    expect((approved.body as TaskDesignView).status).toBe('approved');
    const writes = await h.ctx.prisma.planTurn.findMany({
      where: { planId: plan.id, action: 'write' },
    });
    expect(writes).toHaveLength(1);
    const writePrompt = h.turnPrompts().at(-1) ?? '';
    expect(writePrompt).toContain('## Approved design');
    // #833: the page template's two frames.
    expect(writePrompt).toContain('docs/design/<issue>-task-t1/1/screen.html');
    expect(writePrompt).toContain(
      'docs/design/<issue>-task-t1/1/breakdown.html',
    );

    const detail = await h.detail(plan.id);
    expect(detail.tasks.find((t) => t.key === 't1')?.status).toBe('ready');
    await h.finish(
      plan.id,
      block({
        action: 'write',
        taskKey: 't1',
        document: FEATURE_DOC,
        assumptions: [],
      }),
    );
    const ok = await h.author.send(
      'post',
      `${h.base(plan.id)}/tasks/t1/review`,
      {
        decision: 'approve',
      },
    );
    expect(ok.status).toBe(200);
    expect((await h.auditOf('design.generated')).length).toBe(1);
    expect((await h.auditOf('design.approved')).length).toBe(1);
  });

  it('a v1 plan takes no suggestions; a design switched on by hand gets the design contract', async () => {
    await h.seedProfile();
    const plan = await h.createPlan('batch');
    await h.ctx.prisma.plan.update({
      where: { id: plan.id },
      data: { contractVersion: 1 },
    });
    const { design: _ignored, ...v1Task } = task('t1');
    await h.finish(
      plan.id,
      block({ action: 'decompose', title: 'Exporter', tasks: [v1Task] }),
    );
    const detail = await h.detail(plan.id);
    expect(detail.tasks).toHaveLength(1);
    expect(detail.tasks[0]).toMatchObject({ status: 'ready', design: null });

    const toggled = await h.author.send('patch', h.designBase(plan.id, 't1'), {
      needed: true,
    });
    expect(toggled.status).toBe(200);
    expect((await h.detail(plan.id)).tasks[0].status).toBe('needs_design');
    expect((await h.auditOf('design.toggled')).length).toBe(1);

    expect((await generate(plan.id)).status).toBe(201);
    const prompt = h.turnPrompts().at(-1) ?? '';
    expect(prompt).toContain('# Output contract (v1)');
    expect(prompt).toContain('## The design action');
    await h.finish(plan.id, designResult({ taskKey: 't1', variant: 1 }));
    expect((await design(plan.id)).revisions).toHaveLength(1);
  });

  it('builds the profile before the first design turn, which carries its summary and kit', async () => {
    const plan = await uiPlan();
    expect((await generate(plan.id)).status).toBe(201);
    expect(h.designSent('uiprofile.build')).toHaveLength(1);
    expect(h.sentOf('plan.turn')).toHaveLength(1); // the decompose only
    expect((await design(plan.id)).status).toBe('generating');
    const building = (await h.viewer.get(`/projects/${h.projectId}/ui-profile`))
      .body as UiProfileView;
    expect(building.status).toBe('building');

    await h.finishBuild(profileResult());
    expect(h.designSent('uiprofile.fingerprint')).toEqual([
      expect.objectContaining({ globs: ['apps/web/src/styles/**'] }),
    ]);
    const profile = (await h.viewer.get(`/projects/${h.projectId}/ui-profile`))
      .body as UiProfileView;
    expect(profile).toMatchObject({
      status: 'fresh',
      current: { version: 1, source: 'agent', fingerprint: hash('a') },
    });
    const prompt = h.turnPrompts().at(-1) ?? '';
    expect(prompt).toContain('Action: `design`');
    expect(prompt).toContain('PROFILE SUMMARY');
    expect(prompt).toContain('PROFILE KIT');
    expect((await h.auditOf('uiprofile.built')).length).toBe(1);
    const run = await h.ctx.prisma.run.findFirstOrThrow({
      where: { projectId: h.projectId, kind: 'ui_profile' },
    });
    expect(run.status).toBe('succeeded');
  });

  it('runs no build on an unchanged fingerprint, and rebuilds first when the files changed', async () => {
    const plan = await drawn(1);
    expect(h.designSent('uiprofile.fingerprint')).toHaveLength(1);
    expect(h.designSent('uiprofile.build')).toHaveLength(0);

    await h.author.send('patch', h.designBase(plan.id, 't1'), {
      variantCount: 2,
    });
    h.fingerprint = hash('b');
    expect((await generate(plan.id)).status).toBe(201);
    expect(h.designSent('uiprofile.build')).toHaveLength(1);
    expect((await design(plan.id)).status).toBe('generating');
    await h.finishBuild('no block at all', 'succeeded');
    expect((await design(plan.id)).status).toBe('reviewing');
    const stale = (await h.viewer.get(`/projects/${h.projectId}/ui-profile`))
      .body as UiProfileView;
    expect(stale.status).toBe('stale');
  });

  it('keeps a manual edit as an obligation of the next build', async () => {
    await h.seedProfile();
    const edit = {
      summary: 'EDITED SUMMARY by a person',
      kit: ':root{--edited:1}',
      snippets: [{ name: 'button', html: '<button>Edited</button>' }],
    };
    const operator = await h.author.send(
      'put',
      `/projects/${h.projectId}/ui-profile`,
      edit,
    );
    expect(operator.status).toBe(403);
    const saved = await h.admin.send(
      'put',
      `/projects/${h.projectId}/ui-profile`,
      edit,
    );
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ version: 2, source: 'manual' });
    expect((await h.auditOf('uiprofile.edited')).length).toBe(1);

    const rebuilt = await h.author.send(
      'post',
      `/projects/${h.projectId}/ui-profile/rebuild`,
    );
    expect(rebuilt.status).toBe(201);
    const [build] = h.designSent('uiprofile.build');
    expect(String(build.prompt)).toContain('## Obligations');
    expect(String(build.prompt)).toContain('EDITED SUMMARY by a person');
    await h.finishBuild(profileResult());
    const v3 = await h.viewer.get(
      `/projects/${h.projectId}/ui-profile/versions?version=3`,
    );
    expect(v3.body.obligations).toContain('EDITED SUMMARY by a person');
    const list = await h.viewer.get(
      `/projects/${h.projectId}/ui-profile/versions`,
    );
    expect(list.body.items.map((i: { version: number }) => i.version)).toEqual([
      3, 2, 1,
    ]);
  });

  it('refuses a manual edit whose snippet navigates the frame', async () => {
    await h.seedProfile();
    const res = await h.admin.send(
      'put',
      `/projects/${h.projectId}/ui-profile`,
      {
        summary: 'summary',
        kit: ':root{--edited:1}',
        snippets: [
          {
            name: 'button',
            html: '<button onclick="location.href=\'https://evil.test\'">Go</button><script>location.href = "https://evil.test"</script>',
          },
        ],
      },
    );
    expect(res.status).toBe(400);
    const versions = await h.viewer.get(
      `/projects/${h.projectId}/ui-profile/versions`,
    );
    expect(versions.body.items).toHaveLength(1);
  });

  it('draws three variants as three turns, one after another', async () => {
    const plan = await drawn(3);
    const view = await design(plan.id);
    expect(view.status).toBe('reviewing');
    expect(view.revisions.map((r) => r.variant)).toEqual([1, 2, 3]);
    const designs = h
      .turnPrompts()
      .filter((p) => p.includes('Action: `design`'));
    expect(designs).toHaveLength(3);
    expect(designs[1]).toContain('Draw variant 2 of 3');
    const again = await generate(plan.id);
    expect(again.status).toBe(409);
  });

  it.each([
    [
      '<script src="https://evil.example/x.js"></script>',
      'design_host_not_allowed',
    ],
    [
      '<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>',
      'design_unpinned_version',
    ],
    ['<script>fetch("/api/me")</script>', 'design_forbidden_feature'],
    [`<p>${'x'.repeat(161 * 1024)}</p>`, 'design_too_large'],
    ['<script>const top = 1;</script>', 'design_script_invalid'],
    ['<script>render(;</script>', 'design_script_invalid'],
  ])('fails a mockup that breaks a rule and stores no revision (%#)', async (body, reason) => {
    await h.seedProfile();
    const plan = await uiPlan();
    await generate(plan.id);
    await h.finish(
      plan.id,
      designResult({ taskKey: 't1', variant: 1 }, [
        {
          name: 'Screen',
          kind: 'screen',
          html: `<!doctype html><html><body>${body}</body></html>`,
        },
      ]),
    );
    const turn = await h.ctx.prisma.planTurn.findFirstOrThrow({
      where: { planId: plan.id, action: 'design' },
    });
    expect(turn.phase).toBe('failed');
    expect(turn.error).toContain(`contract_violation: ${reason}`);
    const view = await design(plan.id);
    expect(view.revisions).toHaveLength(0);
    expect(view.status).toBe('idle');
  });

  it('#686: stores frames over 160 KiB together, each under it, sent in chunk events', async () => {
    await h.seedProfile();
    const plan = await uiPlan();
    await generate(plan.id);
    const frame = (name: string) => ({
      name,
      html: `<!doctype html><html><body><p>${name}${'x'.repeat(100 * 1024)}</p></body></html>`,
    });
    const frames = [frame('Board'), frame('Card')];
    const text = designResult({ taskKey: 't1', variant: 1 }, frames);
    expect(Buffer.byteLength(text)).toBeGreaterThan(PLAN_TURN_RESULT_MAX_BYTES);
    await h.finishChunked(plan.id, text);
    const turn = await h.ctx.prisma.planTurn.findFirstOrThrow({
      where: { planId: plan.id, action: 'design' },
    });
    expect(turn.error).toBeNull();
    expect(turn.phase).toBe('succeeded');
    expect(turn.resultText).toBe(text);
    const view = await design(plan.id);
    expect(view.revisions).toHaveLength(1);
    const stored = await h.ctx.prisma.designFrame.findMany({
      where: { revisionId: view.revisions[0]?.id },
      orderBy: { position: 'asc' },
    });
    expect(stored.map((f) => f.name)).toEqual(['Board', 'Card']);
    expect(stored.map((f) => Buffer.byteLength(f.html))).toEqual(
      frames.map((f) => Buffer.byteLength(f.html)),
    );
  });

  it('#686: fails a chunked result with a chunk missing as truncated', async () => {
    await h.seedProfile();
    const plan = await uiPlan();
    await generate(plan.id);
    const html = `<!doctype html><html><body><p>${'x'.repeat(150 * 1024)}</p></body></html>`;
    await h.finishChunked(
      plan.id,
      designResult({ taskKey: 't1', variant: 1 }, [
        { name: 'A', html },
        { name: 'B', html },
      ]),
      [1],
    );
    const turn = await h.ctx.prisma.planTurn.findFirstOrThrow({
      where: { planId: plan.id, action: 'design' },
    });
    expect(turn.phase).toBe('failed');
    expect(turn.error).toContain('contract_violation: result_truncated');
    expect((await design(plan.id)).revisions).toHaveLength(0);
  });

  it('serves the mockup and the profile preview sandboxed with the pin helper, and hides them from who may not read', async () => {
    const none = await h.viewer.get(
      `/projects/${h.projectId}/ui-profile/preview`,
    );
    expect(none.status).toBe(404);

    const plan = await drawn(1);
    const [revision] = (await design(plan.id)).revisions;
    const html = await h.author.get(`/design-revisions/${revision.id}/html`);
    const preview = await h.viewer.get(
      `/projects/${h.projectId}/ui-profile/preview?version=1`,
    );
    for (const res of [html, preview]) {
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain('sandbox allow-scripts');
      expect(csp).not.toContain('allow-same-origin');
      expect(csp).toContain("connect-src 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.text).toContain(MOCKUP_PIN_HELPER_ATTRIBUTE);
    }
    expect(html.text).toContain('<button>Export</button>');
    // The web's iframe may probe the preview with HEAD; nothing refuses it.
    const head = await h.ctx
      .http()
      .head(`/projects/${h.projectId}/ui-profile/preview?version=1`)
      .set(
        'Cookie',
        `${SESSION_COOKIE}=${h.viewer.token}; ${CSRF_COOKIE}=${h.viewer.csrf}`,
      );
    expect(head.status).toBe(200);
    expect(String(head.headers['content-security-policy'])).toContain(
      'sandbox allow-scripts',
    );
    // A task with no design row: 404, not an empty design.
    expect((await h.author.get(h.designBase(plan.id, 't2'))).status).toBe(404);
    expect(preview.text).toContain('<div class="card">Card</div>');
    const stored = await h.ctx.prisma.designFrame.findMany({
      where: { revisionId: revision.id },
    });
    expect(
      stored
        .sort((a, b) => a.position - b.position)
        .map((f) => [f.position, f.name, f.kind, f.templateFrameKey, f.html]),
    ).toEqual([
      [0, 'Screen', 'screen', 'screen', MOCKUP],
      [1, 'Breakdown', 'breakdown', 'breakdown', MOCKUP],
    ]);
    expect(
      (
        await h.viewer.get(
          `/projects/${h.projectId}/ui-profile/preview?version=9`,
        )
      ).status,
    ).toBe(404);

    // A private plan: another operator and an outsider see nothing.
    for (const session of [h.other, h.outsider]) {
      expect(
        (await session.get(`/design-revisions/${revision.id}/html`)).status,
      ).toBe(404);
    }
    expect((await h.other.get(h.designBase(plan.id, 't1'))).status).toBe(404);

    // Shared: a viewer reads, and is refused every write.
    await h.ctx.prisma.plan.update({
      where: { id: plan.id },
      data: { visibility: 'project' },
    });
    expect((await h.viewer.get(h.designBase(plan.id, 't1'))).status).toBe(200);
    expect(
      (await h.viewer.get(`/design-revisions/${revision.id}/html`)).status,
    ).toBe(200);
    const base = h.designBase(plan.id, 't1');
    for (const [method, path, body] of [
      ['patch', base, { needed: false }],
      ['post', `${base}/generate`, undefined],
      ['post', `${base}/revise`, undefined],
      ['post', `${base}/approve`, { revisionId: revision.id }],
      [
        'post',
        `${base}/comments`,
        { revisionId: revision.id, kind: 'general', body: 'No.' },
      ],
    ] as const) {
      expect((await h.viewer.send(method, path, body)).status).toBe(403);
    }
  });

  it('serves a card revision to every project member, and 404 to a non-member (#243 D8)', async () => {
    await h.seedProfile();
    const cards = `/projects/${h.projectId}/board/cards`;
    const created = await h.author.send('post', cards, { title: 'Add login' });
    expect(created.status).toBe(201);
    const card = created.body as { id: string; number: number };
    const base = `${cards}/${card.number}/design`;
    expect((await h.author.send('patch', base, { needed: true })).status).toBe(
      200,
    );
    expect((await h.author.send('post', `${base}/generate`)).status).toBe(201);
    const turn = await h.ctx.prisma.planTurn.findFirstOrThrow({
      where: { cardId: card.id, phase: { in: ['queued', 'running'] } },
    });
    await h.sinks.dispatch(h.runnerId, [
      h.event('plan_turn.finished', {
        planId: card.id,
        turnId: turn.id,
        runId: turn.runId,
        projectId: h.projectId,
        phase: 'succeeded',
        at: new Date().toISOString(),
        exitCode: 0,
        resultText: designResult({ taskKey: 'card-1', variant: 1 }),
        resultTruncated: false,
      }),
    ]);
    const [revision] = ((await h.viewer.get(base)).body as TaskDesignView)
      .revisions;
    const url = `/design-revisions/${revision.id}/html`;
    // No plan rule applies: a card's design is the project's.
    for (const session of [h.author, h.other, h.viewer, h.admin]) {
      const res = await session.get(url);
      expect(res.status).toBe(200);
      expect(String(res.headers['content-security-policy'])).toContain(
        'sandbox allow-scripts',
      );
      expect(res.text).toContain(MOCKUP_PIN_HELPER_ATTRIBUTE);
    }
    expect((await h.outsider.get(url)).status).toBe(404);
  });

  it('carries a pin to the next turn, revises every variant in play, and archives the variants not picked', async () => {
    const plan = await drawn(2);
    const base = h.designBase(plan.id, 't1');
    const [v1, v2] = (await design(plan.id)).revisions;
    expect((await h.author.send('post', `${base}/revise`)).body.error).toBe(
      'no_open_comments',
    );

    const pinned = await h.author.send('post', `${base}/comments`, {
      revisionId: v1.id,
      kind: 'pin',
      viewport: 'Mobile',
      theme: 'dark',
      x: 120,
      y: 640,
      selector: '#app > button:nth-of-type(1)',
      body: 'Make this full width.',
    });
    expect(pinned.status).toBe(201);
    const general = await h.author.send('post', `${base}/comments`, {
      revisionId: v2.id,
      kind: 'general',
      body: 'Too dense overall.',
    });
    const comments = (general.body as TaskDesignView).comments;
    const pin = comments.find((c) => c.kind === 'pin');
    expect(pin).toMatchObject({
      viewport: 'Mobile',
      theme: 'dark',
      x: 120,
      y: 640,
      selector: '#app > button:nth-of-type(1)',
      addressedInRevisionId: null,
    });
    const other = comments.find((c) => c.kind === 'general');
    if (!pin || !other) throw new Error('comments missing');
    const badPin = await h.author.send('post', `${base}/comments`, {
      revisionId: v1.id,
      kind: 'pin',
      body: 'No anchor',
    });
    expect(badPin.status).toBe(400);

    expect((await h.author.send('post', `${base}/revise`)).status).toBe(201);
    expect((await design(plan.id)).status).toBe('revising');
    const revisePrompt = h.turnPrompts().at(-1) ?? '';
    expect(revisePrompt).toContain('#app > button:nth-of-type(1)');
    expect(revisePrompt).toContain(pin.id);
    expect(revisePrompt).toContain(other.id);
    await h.finish(
      plan.id,
      designResult({ taskKey: 't1', variant: 1, addressed: [pin.id] }),
    );
    // Variant 2 may answer the comment variant 1 left open, and not re-claim the pin.
    await h.finish(
      plan.id,
      designResult({
        taskKey: 't1',
        variant: 2,
        addressed: [other.id, pin.id],
      }),
    );
    const revised = await design(plan.id);
    expect(revised.status).toBe('reviewing');
    expect(revised.revisions.map((r) => [r.variant, r.revision])).toEqual([
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
    ]);
    const byId = new Map(revised.comments.map((c) => [c.id, c]));
    const v1r2 = revised.revisions.find(
      (r) => r.variant === 1 && r.revision === 2,
    );
    const v2r2 = revised.revisions.find(
      (r) => r.variant === 2 && r.revision === 2,
    );
    expect(byId.get(pin.id)?.addressedInRevisionId).toBe(v1r2?.id);
    expect(byId.get(other.id)?.addressedInRevisionId).toBe(v2r2?.id);
    expect((await h.auditOf('design.revised')).length).toBe(1);

    const approved = await h.author.send('post', `${base}/approve`, {
      revisionId: v2r2?.id,
    });
    expect(approved.status).toBe(200);
    const after = approved.body as TaskDesignView;
    expect(
      after.revisions.filter((r) => r.archived).map((r) => r.variant),
    ).toEqual([1, 1]);
    expect(after.approvedRevisionId).toBe(v2r2?.id);
  });

  it('publishes the approved design next to the spec, without the pin helper — also for issue_body', async () => {
    await h.ctx.prisma.project.update({
      where: { id: h.projectId },
      data: {
        codeSentinelConfig: { orchestrator: { specDir: 'docs/specs' } },
      },
    });
    await h.ctx.prisma.plannerSettings.create({
      data: { projectId: h.projectId, specOutput: 'issue_body' },
    });
    const plan = await drawn(1);
    const [revision] = (await design(plan.id)).revisions;
    await h.author.send('post', `${h.designBase(plan.id, 't1')}/approve`, {
      revisionId: revision.id,
    });
    await h.finish(
      plan.id,
      block({
        action: 'write',
        taskKey: 't1',
        document: `${FEATURE_DOC}\n## Design\n\nThe mockup is \`docs/specs/<issue>-task-t1/design/1/screen.html\`.\n`,
        assumptions: [],
      }),
    );
    for (const key of ['t1', 't2']) {
      await h.author.send('post', `${h.base(plan.id)}/tasks/${key}/review`, {
        decision: 'approve',
      });
    }
    const sent = await h.author.send('post', `${h.base(plan.id)}/send`);
    expect(sent.status).toBe(200);
    const [publish] = h.sentOf('plan.publish_specs');
    const files = publish.files as { path: string; content: string }[];
    expect(files.map((f) => f.path)).toEqual([
      'docs/specs/101-task-t1.md',
      'docs/specs/101-task-t1/design/1/screen.html',
      'docs/specs/101-task-t1/design/1/breakdown.html',
    ]);
    expect(files[0].content).toContain(
      '`docs/specs/101-task-t1/design/1/screen.html`',
    );
    expect(files[1].content).toBe(MOCKUP);
    expect(files[1].content).not.toContain(MOCKUP_PIN_HELPER_ATTRIBUTE);
    // t2 (issue_body, no design) is queued now; t1 waits for the docs PR.
    expect(h.sentOf('plan.queue_issues')).toEqual([
      expect.objectContaining({ numbers: [102] }),
    ]);
    await h.sinks.dispatch(h.runnerId, [
      h.event('pr.closed', {
        number: 7,
        branch: publish.branch,
        merged: true,
      }),
    ]);
    expect(h.sentOf('plan.queue_issues')[1]).toEqual(
      expect.objectContaining({ numbers: [101] }),
    );
  });

  // #441: a design of several named frames.
  // #833: the page template's screen, breakdown and optional states.
  const FRAMES = [
    {
      name: 'Board page',
      kind: 'screen',
      html: MOCKUP.replace('Export', 'Board'),
    },
    {
      name: 'Card tile',
      kind: 'breakdown',
      html: MOCKUP.replace('Export', 'Tile'),
    },
    {
      name: 'Card tile!',
      kind: 'states',
      html: MOCKUP.replace('Export', 'Tile 2'),
    },
  ] as const;

  it('stores the frames of a turn in order, serves each, and keeps a comment on its frame into the next Revise (#441)', async () => {
    await h.seedProfile();
    const plan = await uiPlan(1);
    expect((await generate(plan.id)).status).toBe(201);
    await h.finish(
      plan.id,
      designResult({ taskKey: 't1', variant: 1 }, FRAMES),
    );
    const [revision] = (await design(plan.id)).revisions;
    expect(revision.frames).toEqual([
      {
        position: 0,
        name: 'Board page',
        slug: 'board-page',
        htmlUrl: `/api/design-revisions/${revision.id}/frames/0/html`,
        kind: 'screen',
        templateFrameKey: 'screen',
      },
      {
        position: 1,
        name: 'Card tile',
        slug: 'card-tile',
        htmlUrl: `/api/design-revisions/${revision.id}/frames/1/html`,
        kind: 'breakdown',
        templateFrameKey: 'breakdown',
      },
      {
        position: 2,
        name: 'Card tile!',
        slug: 'card-tile-2',
        htmlUrl: `/api/design-revisions/${revision.id}/frames/2/html`,
        kind: 'states',
        templateFrameKey: 'states',
      },
    ]);
    expect(revision.templateKey).toBe('page');
    expect(revision.conformance).toEqual({
      ok: true,
      missing: [],
      extra: [],
      misplaced: [],
    });
    const tile = await h.author.get(
      `/design-revisions/${revision.id}/frames/1/html`,
    );
    expect(tile.status).toBe(200);
    expect(tile.text).toContain('<button>Tile</button>');
    expect(tile.text).toContain(MOCKUP_PIN_HELPER_ATTRIBUTE);
    expect(String(tile.headers['content-security-policy'])).toContain(
      'sandbox allow-scripts',
    );
    expect(
      (await h.author.get(`/design-revisions/${revision.id}/html`)).text,
    ).toContain('<button>Board</button>');
    expect(
      (await h.author.get(`/design-revisions/${revision.id}/frames/3/html`))
        .status,
    ).toBe(404);
    expect(
      (await h.other.get(`/design-revisions/${revision.id}/frames/1/html`))
        .status,
    ).toBe(404);

    const base = h.designBase(plan.id, 't1');
    const pinned = await h.author.send('post', `${base}/comments`, {
      revisionId: revision.id,
      frame: 1,
      kind: 'pin',
      viewport: 'Desktop',
      theme: 'light',
      x: 10,
      y: 20,
      selector: '#app > button',
      body: 'Round the corners.',
    });
    expect(pinned.status).toBe(201);
    const outside = await h.author.send('post', `${base}/comments`, {
      revisionId: revision.id,
      frame: 3,
      kind: 'general',
      body: 'Nowhere.',
    });
    expect(outside.status).toBe(400);
    // After a reload the pin is still on its frame.
    const [pin] = (await design(plan.id)).comments;
    expect(pin).toMatchObject({ frame: 1, kind: 'pin', x: 10, y: 20 });

    expect((await h.author.send('post', `${base}/revise`)).status).toBe(201);
    const prompt = h.turnPrompts().at(-1) ?? '';
    expect(prompt).toContain(
      'Its frames, in order: "Board page" (screen), "Card tile" (breakdown), "Card tile!" (states).',
    );
    expect(prompt).toContain('"frame": "Card tile"');
    expect(prompt).toContain(pin.id);
    // #628: the frame the pin is on in full, a summary of the others, in a
    // session of the revise's own.
    expect(prompt).toContain('#### Frame "Card tile"');
    expect(prompt).toContain('<button>Tile</button>');
    expect(prompt).not.toContain('<button>Board</button>');
    expect(prompt).toContain('- "Board page" — 1 KiB');
    const task = await h.ctx.prisma.planTask.findFirstOrThrow({
      where: { planId: plan.id, key: 't1' },
    });
    const session = h.sentOf('plan.turn').at(-1)?.session as {
      id: string;
      resume: boolean;
    };
    expect(session.resume).toBe(false);
    expect(session.id).not.toBe(task.sessionId);

    // The turn draws the tile and keeps the other two as they were.
    const retile = MOCKUP.replace('Export', 'Rounded tile');
    await h.finish(
      plan.id,
      designResult(
        {
          taskKey: 't1',
          variant: 1,
          addressed: [pin.id],
          kept: ['Board page', 'Card tile!'],
        },
        [
          FRAMES[0],
          { name: 'Card tile', kind: 'breakdown', html: retile },
          FRAMES[2],
        ],
      ),
    );
    const next = (await design(plan.id)).revisions.find(
      (r) => r.revision === 2,
    );
    if (!next) throw new Error('expected revision 2');
    const htmlOf = async (position: number) =>
      (
        await h.author.get(
          `/design-revisions/${next.id}/frames/${position}/html`,
        )
      ).text;
    expect(next.frames.map((f) => f.name)).toEqual(FRAMES.map((f) => f.name));
    expect(await htmlOf(0)).toContain('<button>Board</button>');
    expect(await htmlOf(1)).toContain('<button>Rounded tile</button>');
    expect(await htmlOf(2)).toContain('<button>Tile 2</button>');
    // The task's own session is left as it was.
    expect(
      (
        await h.ctx.prisma.planTask.findUniqueOrThrow({
          where: { id: task.id },
        })
      ).sessionId,
    ).toBe(task.sessionId);
  });

  it('reads a revision stored before frames as one frame named Mockup (#441)', async () => {
    const plan = await drawn(1);
    const [drawnRevision] = (await design(plan.id)).revisions;
    const stored = await h.ctx.prisma.designRevision.findUniqueOrThrow({
      where: { id: drawnRevision.id },
    });
    // As a revision stored before #441: the HTML on the row, no frames.
    const legacy = await h.ctx.prisma.designRevision.create({
      data: {
        designId: stored.designId,
        variant: 1,
        revision: 2,
        title: 'Legacy',
        rationale: 'One mockup.',
        html: MOCKUP.replace('Export', 'Legacy'),
        turnId: stored.turnId,
      },
    });
    const view = await design(plan.id);
    const read = view.revisions.find((r) => r.id === legacy.id);
    expect(read?.frames).toEqual([
      {
        position: 0,
        name: 'Mockup',
        slug: 'mockup',
        htmlUrl: `/api/design-revisions/${legacy.id}/frames/0/html`,
        kind: 'legacy',
        templateFrameKey: null,
      },
    ]);
    // #833: a legacy revision is never checked — no "not per template" badge.
    expect(read?.templateKey).toBeNull();
    expect(read?.conformance).toBeNull();
    for (const url of [
      `/design-revisions/${legacy.id}/html`,
      `/design-revisions/${legacy.id}/frames/0/html`,
    ]) {
      const res = await h.author.get(url);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<button>Legacy</button>');
    }
    expect(
      (await h.author.get(`/design-revisions/${legacy.id}/frames/1/html`))
        .status,
    ).toBe(404);

    const base = h.designBase(plan.id, 't1');
    const commented = await h.author.send('post', `${base}/comments`, {
      revisionId: legacy.id,
      kind: 'general',
      body: 'Bigger title.',
    });
    expect(commented.status).toBe(201);
    expect((commented.body as TaskDesignView).comments[0].frame).toBe(0);
    expect(
      (
        await h.author.send('post', `${base}/comments`, {
          revisionId: legacy.id,
          frame: 1,
          kind: 'general',
          body: 'No such frame.',
        })
      ).status,
    ).toBe(400);
    expect((await h.author.send('post', `${base}/revise`)).status).toBe(201);
    const prompt = h.turnPrompts().at(-1) ?? '';
    expect(prompt).toContain('Its frames, in order: "Mockup" (legacy).');
    expect(prompt).toContain('"frame": "Mockup"');

    // Approved, the legacy revision publishes as its one frame.
    await h.finish(plan.id, designResult({ taskKey: 't1', variant: 1 }));
    await h.ctx.prisma.taskDesign.update({
      where: { id: stored.designId },
      data: { status: 'reviewing' },
    });
    expect(
      (
        await h.author.send('post', `${base}/approve`, {
          revisionId: legacy.id,
        })
      ).status,
    ).toBe(200);
    expect(h.turnPrompts().at(-1)).toContain(
      'docs/design/<issue>-task-t1/1/mockup.html',
    );
  });

  // #863 (ADR-0084): a page revision drawn before the mobile frame left the
  // template keeps its stored check; nothing reads its frames again.
  it('loads a revision with a mobile frame as it was stored (#863)', async () => {
    const plan = await drawn(1);
    const [drawnRevision] = (await design(plan.id)).revisions;
    const stored = await h.ctx.prisma.designRevision.findUniqueOrThrow({
      where: { id: drawnRevision.id },
    });
    const html = (name: string) => MOCKUP.replace('Export', name);
    const older = await h.ctx.prisma.designRevision.create({
      data: {
        designId: stored.designId,
        variant: 1,
        revision: 2,
        title: 'With mobile',
        rationale: 'A frame per width.',
        html: html('Screen'),
        turnId: stored.turnId,
        templateKey: 'page',
        conformance: { ok: true, missing: [], extra: [], misplaced: [] },
        frames: {
          create: [
            ['Screen', 'screen', 'screen'],
            ['Breakdown', 'breakdown', 'breakdown'],
            ['States and mobile', 'mobile', 'mobile'],
          ].map(([name, kind, key], position) => ({
            position,
            name,
            slug: name.toLowerCase().replaceAll(' ', '-'),
            html: html(name),
            kind: kind as 'screen' | 'breakdown' | 'mobile',
            templateFrameKey: key,
          })),
        },
      },
    });
    const read = (await design(plan.id)).revisions.find(
      (r) => r.id === older.id,
    );
    expect(read?.frames.map((f) => f.kind)).toEqual([
      'screen',
      'breakdown',
      'mobile',
    ]);
    expect(read?.conformance).toEqual({
      ok: true,
      missing: [],
      extra: [],
      misplaced: [],
    });
    const frame = await h.author.get(
      `/design-revisions/${older.id}/frames/2/html`,
    );
    expect(frame.status).toBe(200);
    expect(frame.text).toContain('<button>States and mobile</button>');
  });

  it('stores the project presets, or the built-in devices, when Generate names none (#863)', async () => {
    await h.seedProfile();
    const first = await uiPlan();
    expect((await generate(first.id)).status).toBe(201);
    expect((await design(first.id)).devices).toEqual([
      { name: 'Desktop', width: 1440, height: 900 },
      { name: 'Tablet', width: 834, height: 1194 },
      { name: 'Phone', width: 390, height: 844 },
    ]);
    const prompt = h.turnPrompts().at(-1) ?? '';
    expect(prompt).toContain('- Tablet: 834 × 1194 px');

    const presets = [
      { name: 'Laptop', width: 1280, height: 800 },
      { name: 'Watch', width: 320, height: 320, theme: 'dark' as const },
    ];
    await h.admin.send('put', `/projects/${h.projectId}/design-settings`, {
      viewports: presets,
      defaultSkills: [],
    });
    const second = await uiPlan();
    expect((await generate(second.id)).status).toBe(201);
    expect((await design(second.id)).devices).toEqual(presets);
    // The first design keeps the built-ins it was generated with.
    expect((await design(first.id)).devices?.map((d) => d.name)).toEqual([
      'Desktop',
      'Tablet',
      'Phone',
    ]);
  });

  it('stores the devices a plan task Generate names (#863)', async () => {
    await h.seedProfile();
    const plan = await uiPlan();
    const devices = [{ name: 'Wide', width: 1920, height: 1080 }];
    const res = await h.author.send(
      'post',
      `${h.designBase(plan.id, 't1')}/generate`,
      { devices },
    );
    expect(res.status).toBe(201);
    expect((await design(plan.id)).devices).toEqual(devices);
    expect(h.turnPrompts().at(-1)).toContain('- Wide: 1920 × 1080 px');
  });

  it('publishes every frame of the approved variant into the docs pull request (#441)', async () => {
    await h.ctx.prisma.project.update({
      where: { id: h.projectId },
      data: {
        codeSentinelConfig: { orchestrator: { specDir: 'docs/specs' } },
      },
    });
    await h.seedProfile();
    const plan = await uiPlan(1);
    expect((await generate(plan.id)).status).toBe(201);
    await h.finish(
      plan.id,
      designResult({ taskKey: 't1', variant: 1 }, FRAMES),
    );
    const [revision] = (await design(plan.id)).revisions;
    await h.author.send('post', `${h.designBase(plan.id, 't1')}/approve`, {
      revisionId: revision.id,
    });
    const writePrompt = h.turnPrompts().at(-1) ?? '';
    expect(writePrompt).toContain('in 3 frames published under');
    expect(writePrompt).toContain(
      '- `docs/specs/<issue>-task-t1/design/1/card-tile.html` — Card tile',
    );
    // The document names no frame: send adds a Design section listing them.
    await h.finish(
      plan.id,
      block({
        action: 'write',
        taskKey: 't1',
        document: FEATURE_DOC,
        assumptions: [],
      }),
    );
    for (const key of ['t1', 't2']) {
      await h.author.send('post', `${h.base(plan.id)}/tasks/${key}/review`, {
        decision: 'approve',
      });
    }
    expect(
      (await h.author.send('post', `${h.base(plan.id)}/send`)).status,
    ).toBe(200);
    const [publish] = h.sentOf('plan.publish_specs');
    const files = publish.files as { path: string; content: string }[];
    const spec = files.find((f) => f.path.endsWith('.md'));
    const designs = files.filter((f) => f.path.endsWith('.html'));
    expect(designs).toEqual([
      {
        path: 'docs/specs/101-task-t1/design/1/board-page.html',
        content: FRAMES[0].html,
      },
      {
        path: 'docs/specs/101-task-t1/design/1/card-tile.html',
        content: FRAMES[1].html,
      },
      {
        path: 'docs/specs/101-task-t1/design/1/card-tile-2.html',
        content: FRAMES[2].html,
      },
    ]);
    expect(spec?.content).toContain('The approved design has 3 frames');
    expect(spec?.content).toContain(
      '- `docs/specs/101-task-t1/design/1/card-tile-2.html` — Card tile!',
    );
    expect(String(publish.body)).toContain(
      'design `docs/specs/101-task-t1/design/1/` (3 frames)',
    );
  });

  it('turns suggestions off for a project without UI, and warns about a default skill no longer installed', async () => {
    await h.seedProfile({ hasUi: false });
    const settings = await h.admin.send(
      'put',
      `/projects/${h.projectId}/design-settings`,
      {
        viewports: [{ name: 'Desktop', width: 1440, height: 900 }],
        // Skills are keyed by their invocation (`InstalledSkillView.invocation`).
        defaultSkills: ['design-kit:frontend-design', 'gone-skill'],
      },
    );
    expect(settings.status).toBe(200);
    expect(
      (
        await h.author.send('put', `/projects/${h.projectId}/design-settings`, {
          viewports: [{ name: 'Desktop', width: 1440, height: 900 }],
          defaultSkills: [],
        })
      ).status,
    ).toBe(403);
    expect((await h.auditOf('design.settings_updated')).length).toBe(1);
    await h.ctx.prisma.installedSkill.create({
      data: {
        runnerId: h.runnerId,
        scope: 'plugin',
        runtime: 'claude',
        name: 'frontend-design',
        invocation: 'design-kit:frontend-design',
        path: '/home/u/.claude/skills/frontend-design',
        seenAt: new Date(),
      },
    });

    const plan = await uiPlan();
    expect(h.turnPrompts()[0]).toContain('The project has no user interface');
    expect(plan.tasks.find((t) => t.key === 't1')).toMatchObject({
      status: 'ready',
      design: null,
    });

    await h.author.send('patch', h.designBase(plan.id, 't1'), { needed: true });
    const view = await design(plan.id);
    expect(view.skills).toEqual(['design-kit:frontend-design', 'gone-skill']);
    expect(view.viewports).toEqual([
      { name: 'Desktop', width: 1440, height: 900 },
    ]);
    expect(view.warnings).toEqual([
      expect.objectContaining({ skill: 'gone-skill' }),
    ]);
    // #604: a plan task's design follows a later change of the default.
    await h.admin.send('put', `/projects/${h.projectId}/design-settings`, {
      viewports: [{ name: 'Desktop', width: 1440, height: 900 }],
      defaultSkills: ['design-kit:frontend-design', 'gone-skill', 'gone-too'],
    });
    const followed = await design(plan.id);
    expect(followed.skills).toEqual([
      'design-kit:frontend-design',
      'gone-skill',
      'gone-too',
    ]);
    expect(followed.warnings.map((w) => w.skill)).toEqual([
      'gone-skill',
      'gone-too',
    ]);
    await generate(plan.id);
    const prompt = h.turnPrompts().at(-1) ?? '';
    expect(prompt).toContain('`design-kit:frontend-design`');
    expect(prompt).not.toContain('gone-skill');
  });

  it('refuses a design turn and a profile build when a budget is exceeded', async () => {
    const plan = await uiPlan();
    const gate = h.ctx.app.get(BudgetGate);
    jest
      .spyOn(gate, 'assertAllowed')
      .mockRejectedValue(
        new BudgetExceededError('bud_1', 'project', new Date()),
      );
    const build = await generate(plan.id);
    expect(build.status).toBe(409);
    expect(build.body.error).toBe('budget_exceeded');
    expect(h.designSent('uiprofile.build')).toHaveLength(0);
    expect((await design(plan.id)).status).toBe('idle');

    await h.seedProfile();
    const turn = await generate(plan.id);
    expect(turn.status).toBe(409);
    expect(turn.body.error).toBe('budget_exceeded');
    expect((await design(plan.id)).status).toBe('idle');
  });

  it('two parallel rebuilds start one build; the other is 409 (L-28)', async () => {
    await h.seedProfile();
    const rebuild = () =>
      h.author.send('post', `/projects/${h.projectId}/ui-profile/rebuild`);
    const responses = await Promise.all([rebuild(), rebuild()]);
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    expect(
      await h.ctx.prisma.run.count({ where: { kind: 'ui_profile' } }),
    ).toBe(1);
    expect(h.designSent('uiprofile.build')).toHaveLength(1);
  });

  it('refuses a rebuild with runner_outdated when the runner does not serve uiprofile.build, creating no run (#233)', async () => {
    await h.seedProfile();
    h.advert = {
      commands: ['plan.turn', 'uiprofile.fingerprint'],
      disabled: [],
    };
    const refused = await h.author.send(
      'post',
      `/projects/${h.projectId}/ui-profile/rebuild`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'runner_outdated' });
    expect(refused.body.message).toContain('uiprofile.build');
    expect(
      await h.ctx.prisma.run.count({ where: { kind: 'ui_profile' } }),
    ).toBe(0);
    expect(h.designSent('uiprofile.build')).toHaveLength(0);
  });

  it('refuses Generate before the profile check when the runner lacks a design command, writing nothing (#233)', async () => {
    await h.seedProfile({ fingerprint: '' });
    const plan = await uiPlan();
    const sent = h.sent.length;
    h.advert = {
      commands: ['uiprofile.fingerprint', 'uiprofile.build'],
      disabled: [],
    };
    const refused = await generate(plan.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'runner_outdated' });
    expect(refused.body.message).toContain('plan.turn');
    expect(h.sent).toHaveLength(sent);
    expect((await design(plan.id)).status).toBe('idle');
    const profile = await h.ctx.prisma.uiProfile.findFirstOrThrow({
      where: { projectId: h.projectId },
    });
    expect(profile.fingerprint).toBe('');
    expect((await h.auditOf('design.generated')).length).toBe(0);
  });

  it('generates as before when every design command is advertised (#233)', async () => {
    h.advert = {
      commands: ['plan.turn', 'uiprofile.fingerprint', 'uiprofile.build'],
      disabled: [],
    };
    await h.seedProfile();
    const plan = await uiPlan();
    expect((await generate(plan.id)).status).toBe(201);
    expect((await design(plan.id)).status).toBe('generating');
  });
});
