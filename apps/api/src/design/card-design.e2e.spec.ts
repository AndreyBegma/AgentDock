import { BOARD_ERROR } from '@nautelle/shared';
import { BoardFailure } from '../board/board-error';
import { BudgetGate } from '../budgets/budget-gate';
import { capabilities } from '../runners/testing/runner-e2e';
import { CardDesignHarness } from './testing/card-design-e2e';
import { designResult, profileResult } from './testing/design-e2e';
import { UiProfileService } from './ui-profile.service';

/** A card's design turns answer the contract under this key (#243 D2). */
const KEY = 'card-1';

describe('card design (e2e, #243)', () => {
  const h = new CardDesignHarness();

  beforeAll(() => h.start());
  afterAll(() => h.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  const generate = (number: number) =>
    h.author.send('post', `${h.cardDesignBase(number)}/generate`);

  it('#445: the profile build and the design turn carry the token saver when advertised', async () => {
    const tokenSaverOfRun = async (id: string) =>
      (await h.ctx.prisma.run.findUniqueOrThrow({ where: { id } })).tokenSaver;
    await h.ctx.prisma.runner.update({
      where: { id: h.runnerId },
      data: { capabilities: { ...capabilities, tokenSaver: true } },
    });
    const card = await h.designedCard(1);
    expect((await generate(card.number)).status).toBe(201);
    expect(h.designSent('uiprofile.build')[0].tokenSaver).toEqual({
      enabled: true,
      mcpAllow: [],
    });
    const build = await h.ctx.prisma.run.findFirstOrThrow({
      where: { kind: 'ui_profile' },
    });
    expect(await tokenSaverOfRun(build.id)).toBe(true);

    await h.finishBuild(profileResult());
    const [turn] = h.sentOf('plan.turn');
    expect(turn.tokenSaver).toEqual({ enabled: true, mcpAllow: [] });
    const active = await h.activeCardTurn(card.id);
    expect(await tokenSaverOfRun(active.runId)).toBe(true);
  });

  it('builds the profile first, then sends one plan.turn per variant with planId = card.id in the card design session', async () => {
    const card = await h.designedCard(2);
    const started = await generate(card.number);
    expect(started.status).toBe(201);
    expect(h.designSent('uiprofile.build')).toHaveLength(1);
    expect(h.sentOf('plan.turn')).toHaveLength(0);
    expect((await h.cardDesign(card.number)).status).toBe('generating');

    await h.finishBuild(profileResult());
    const [first] = h.sentOf('plan.turn');
    const stored = await h.ctx.prisma.boardCard.findUniqueOrThrow({
      where: { id: card.id },
    });
    expect(stored.designSessionId).not.toBeNull();
    expect(first).toMatchObject({
      planId: card.id,
      projectId: h.projectId,
      session: { id: stored.designSessionId, resume: false },
    });
    const prompt = String(first.prompt);
    expect(prompt).toContain('GLOBAL INSTRUCTIONS v1');
    expect(prompt).toContain('Action: `design`');
    expect(prompt).toContain(`whose \`taskKey\` is \`${KEY}\``);
    expect(prompt).toContain('## The card');
    expect(prompt).toContain('C-1: Add login');
    expect(prompt).toContain('Users sign in with a password.');
    expect(prompt).toContain('PROFILE KIT');
    expect(prompt).toContain('Variant: 1 (of 2).');
    // The turn belongs to the card, not to a plan; its run is a plan run.
    const turn = await h.activeCardTurn(card.id);
    expect(turn.planId).toBeNull();
    const run = await h.ctx.prisma.run.findUniqueOrThrow({
      where: { id: turn.runId },
    });
    expect(run.kind).toBe('plan');
    expect(run.title).toBe('Design · C-1 v1');

    await h.finishCard(card.id, designResult({ taskKey: KEY, variant: 1 }));
    const turns = h.sentOf('plan.turn');
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      planId: card.id,
      session: { id: stored.designSessionId, resume: true },
    });
    expect(String(turns[1].prompt)).toContain('Variant: 2 (of 2).');

    await h.finishCard(card.id, designResult({ taskKey: KEY, variant: 2 }));
    const view = await h.cardDesign(card.number);
    expect(view.owner).toEqual({
      kind: 'card',
      cardId: card.id,
      number: card.number,
    });
    expect(view.planId).toBeNull();
    expect(view.status).toBe('reviewing');
    expect(view.revisions.map((r) => r.variant)).toEqual([1, 2]);
    expect(h.sentOf('plan.turn')).toHaveLength(2);
    // Generating never moves the card.
    const after = await h.ctx.prisma.boardCard.findUniqueOrThrow({
      where: { id: card.id },
    });
    expect(after.column).toBe('todo');
    const audit = await h.auditOf('design.generated');
    expect(audit).toHaveLength(1);
    expect(audit[0].targetType).toBe('board_card');
    expect(audit[0].targetId).toBe(card.id);
  });

  it.each([
    [designResult({ taskKey: 't1', variant: 1 }), 'task_mismatch'],
    [designResult({ taskKey: KEY, variant: 2 }), 'variant_mismatch'],
    [
      designResult(
        { taskKey: KEY, variant: 1 },
        '<!doctype html><html><body><script src="https://evil.example/x.js"></script></body></html>',
      ),
      'design_host_not_allowed',
    ],
    [
      designResult(
        { taskKey: KEY, variant: 1 },
        '<!doctype html><html><body><script>fetch("/api/me")</script></body></html>',
      ),
      'design_forbidden_feature',
    ],
    [
      designResult({ taskKey: KEY, variant: 1 }, [
        {
          name: 'Screen',
          kind: 'screen',
          html: `<!doctype html><html><body><p>${'x'.repeat(161 * 1024)}</p></body></html>`,
        },
      ]),
      'design_too_large',
    ],
    [
      designResult(
        { taskKey: KEY, variant: 1 },
        '<!doctype html><html><body><script>const top = document.body;</script></body></html>',
      ),
      'design_script_invalid',
    ],
  ])('fails a card turn that breaks the contract and stores no revision (%#)', async (result, reason) => {
    await h.seedProfile();
    const card = await h.designedCard(1);
    expect((await generate(card.number)).status).toBe(201);
    await h.finishCard(card.id, result);
    const turn = await h.ctx.prisma.planTurn.findFirstOrThrow({
      where: { cardId: card.id, action: 'design' },
    });
    expect(turn.phase).toBe('failed');
    expect(turn.error).toContain('contract_violation');
    expect(turn.error).toContain(reason);
    const view = await h.cardDesign(card.number);
    expect(view.revisions).toHaveLength(0);
    expect(view.status).toBe('idle');
    // At rest again: Generate takes a new turn.
    expect((await generate(card.number)).status).toBe(201);
  });

  it('#606: of two Generates at once one starts, and the other leaves the running turn alone', async () => {
    await h.seedProfile();
    const card = await h.designedCard(1);
    const profiles = h.ctx.app.get(UiProfileService);
    const ensureFresh = profiles.ensureFresh.bind(profiles);
    let second: { status: number; body: { error?: string } } | null = null;
    // The second Generate arrives while the first checks the profile.
    jest
      .spyOn(profiles, 'ensureFresh')
      .mockImplementationOnce(async (...args) => {
        second = await generate(card.number);
        return ensureFresh(...args);
      });

    expect((await generate(card.number)).status).toBe(201);
    expect(second).toMatchObject({
      status: 409,
      body: { error: 'design_busy' },
    });
    expect(h.sentOf('plan.turn')).toHaveLength(1);
    const design = await h.cardDesign(card.number);
    expect(design.status).toBe('generating');
    expect(design.activeTurnId).not.toBeNull();
  });

  describe('devices (#863)', () => {
    const WIDE = { name: 'Wide', width: 1920, height: 1080 };
    const KIOSK = { name: 'Kiosk', width: 1080, height: 1920, theme: 'dark' };

    const generateFor = (number: number, devices: object[]) =>
      h.author.send('post', `${h.cardDesignBase(number)}/generate`, {
        devices,
      });

    it('stores the devices a Generate names, and the prompt lists each with its size', async () => {
      await h.seedProfile();
      const card = await h.designedCard(1);
      expect((await h.cardDesign(card.number)).devices).toBeNull();

      expect((await generateFor(card.number, [WIDE, KIOSK])).status).toBe(201);
      expect((await h.cardDesign(card.number)).devices).toEqual([WIDE, KIOSK]);
      const prompt = String(h.sentOf('plan.turn').at(-1)?.prompt);
      expect(prompt).toContain('# Devices');
      expect(prompt).toContain('- Wide: 1920 × 1080 px');
      expect(prompt).toContain('- Kiosk: 1080 × 1920 px, dark theme');
      expect(prompt).toContain('one responsive page');
      expect(prompt).not.toContain('- Desktop:');
    });

    it('keeps the devices when the project presets change later', async () => {
      await h.seedProfile();
      const card = await h.designedCard(1);
      expect((await generate(card.number)).status).toBe(201);
      const stored = (await h.cardDesign(card.number)).devices;
      expect(stored?.map((d) => d.name)).toEqual(['Desktop', 'Tablet', 'Phone']);

      const presets = await h.admin.send(
        'put',
        `/projects/${h.projectId}/design-settings`,
        { viewports: [WIDE], defaultSkills: [] },
      );
      expect(presets.status).toBe(200);
      const view = await h.cardDesign(card.number);
      expect(view.viewports).toEqual([WIDE]);
      expect(view.devices).toEqual(stored);
    });

    it('refuses an empty list, too many devices and two of one name, storing nothing', async () => {
      await h.seedProfile();
      const card = await h.designedCard(1);
      const many = Array.from({ length: 13 }, (_, i) => ({
        ...WIDE,
        name: `D${i}`,
      }));
      for (const devices of [[], many, [WIDE, { ...KIOSK, name: 'Wide' }]]) {
        expect((await generateFor(card.number, devices)).status).toBe(400);
      }
      expect(
        (await generateFor(card.number, [{ ...WIDE, width: 10 }])).status,
      ).toBe(400);
      const view = await h.cardDesign(card.number);
      expect(view.devices).toBeNull();
      expect(view.status).toBe('idle');
      expect(h.sentOf('plan.turn')).toHaveLength(0);
    });

    it('a refused second Generate leaves the devices of the running one', async () => {
      await h.seedProfile();
      const card = await h.designedCard(1);
      const profiles = h.ctx.app.get(UiProfileService);
      const ensureFresh = profiles.ensureFresh.bind(profiles);
      let second: { status: number } | null = null;
      jest
        .spyOn(profiles, 'ensureFresh')
        .mockImplementationOnce(async (...args) => {
          second = await generateFor(card.number, [KIOSK]);
          return ensureFresh(...args);
        });

      expect((await generateFor(card.number, [WIDE])).status).toBe(201);
      expect(second).toMatchObject({ status: 409 });
      expect((await h.cardDesign(card.number)).devices).toEqual([WIDE]);
    });
  });

  it('#628: a revise runs in a session of its own and keeps a frame it does not draw', async () => {
    await h.seedProfile();
    const card = await h.designedCard(1);
    await generate(card.number);
    const frames = [
      {
        name: 'Page',
        kind: 'screen',
        html: '<!doctype html><html><body><h1>Login page</h1><p>PAGE-BODY</p></body></html>',
      },
      {
        name: 'Form',
        kind: 'breakdown',
        html: '<!doctype html><html><body><p>FORM-BODY</p></body></html>',
      },
    ] as const;
    await h.finishCard(
      card.id,
      designResult({ taskKey: KEY, variant: 1 }, frames),
    );
    const base = h.cardDesignBase(card.number);
    const [drawn] = (await h.cardDesign(card.number)).revisions;
    const commented = await h.author.send('post', `${base}/comments`, {
      revisionId: drawn.id,
      frame: 1,
      kind: 'general',
      body: 'Label every field.',
    });
    expect(commented.status).toBe(201);
    expect((await h.author.send('post', `${base}/revise`)).status).toBe(201);

    const stored = await h.ctx.prisma.boardCard.findUniqueOrThrow({
      where: { id: card.id },
    });
    const revise = h.sentOf('plan.turn').at(-1) ?? {};
    const session = revise.session as { id: string; resume: boolean };
    expect(session.resume).toBe(false);
    expect(session.id).not.toBe(stored.designSessionId);
    const prompt = String(revise.prompt);
    expect(prompt).toContain('FORM-BODY');
    expect(prompt).not.toContain('PAGE-BODY');
    expect(prompt).toContain('- "Page" — 1 KiB; headings: "Login page"');
    expect(prompt.indexOf('PROFILE KIT')).toBeLessThan(
      prompt.indexOf('# This turn'),
    );

    await h.finishCard(
      card.id,
      designResult({ taskKey: KEY, variant: 1, kept: ['Page'] }, [
        frames[0],
        {
          name: 'Form',
          kind: 'breakdown',
          html: frames[1].html.replace('FORM', 'LABELLED'),
        },
      ]),
    );
    const next = (await h.cardDesign(card.number)).revisions.find(
      (r) => r.revision === 2,
    );
    if (!next) throw new Error('expected revision 2');
    const html = (position: number) =>
      h.author.get(`/design-revisions/${next.id}/frames/${position}/html`);
    expect((await html(0)).text).toContain('PAGE-BODY');
    expect((await html(1)).text).toContain('LABELLED-BODY');
    // The card's design session stays for its next Generate.
    expect(
      (
        await h.ctx.prisma.boardCard.findUniqueOrThrow({
          where: { id: card.id },
        })
      ).designSessionId,
    ).toBe(stored.designSessionId);
  });

  it('approving chains no write turn, sends plan.close, and with the switch off starts nothing', async () => {
    await h.seedProfile();
    const card = await h.designedCard(2);
    await generate(card.number);
    await h.finishCard(card.id, designResult({ taskKey: KEY, variant: 1 }));
    await h.finishCard(card.id, designResult({ taskKey: KEY, variant: 2 }));
    const view = await h.cardDesign(card.number);
    const picked = view.revisions.find((r) => r.variant === 2);
    if (!picked) throw new Error('variant 2 was not drawn');

    const approved = await h.author.send(
      'post',
      `${h.cardDesignBase(card.number)}/approve`,
      { revisionId: picked.id },
    );
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: 'approved',
      approvedRevisionId: picked.id,
    });
    expect(
      approved.body.revisions.find((r: { variant: number }) => r.variant === 1)
        .archived,
    ).toBe(true);
    expect(
      await h.ctx.prisma.planTurn.count({ where: { action: 'write' } }),
    ).toBe(0);
    expect(h.sentOf('plan.turn')).toHaveLength(2);
    expect(h.sentOf('plan.close')).toEqual([
      { planId: card.id, projectId: h.projectId },
    ]);
    expect(h.cardSentOf('card.run')).toHaveLength(0);
    const stored = await h.ctx.prisma.boardCard.findUniqueOrThrow({
      where: { id: card.id },
      include: { rounds: true },
    });
    expect(stored.column).toBe('todo');
    expect(stored.rounds).toHaveLength(0);
    const audit = await h.auditOf('design.approved');
    expect(audit).toHaveLength(1);
    expect(audit[0].targetType).toBe('board_card');

    // Approved: no more turns, comments or second approval.
    const base = h.cardDesignBase(card.number);
    expect((await generate(card.number)).body.error).toBe('design_approved');
    expect(
      (
        await h.author.send('post', `${base}/approve`, {
          revisionId: picked.id,
        })
      ).body.error,
    ).toBe('design_approved');
  });

  it('a viewer reads a card design and is refused every write; another project sees nothing', async () => {
    await h.seedProfile();
    const card = await h.designedCard(1);
    const base = h.cardDesignBase(card.number);
    expect((await h.viewer.get(base)).status).toBe(200);
    for (const [method, path, body] of [
      ['patch', base, { needed: false }],
      ['post', `${base}/generate`, undefined],
      ['post', `${base}/revise`, undefined],
      ['post', `${base}/approve`, { revisionId: 'x' }],
      [
        'post',
        `${base}/comments`,
        { revisionId: 'x', kind: 'general', body: 'No.' },
      ],
    ] as const) {
      expect((await h.viewer.send(method, path, body)).status).toBe(403);
    }
    expect((await h.outsider.get(base)).status).toBe(404);
    // No design row yet: 404, not an empty design.
    const bare = await h.createCard({ title: 'Bare' });
    expect((await h.author.get(h.cardDesignBase(bare.number))).status).toBe(
      404,
    );
  });

  describe('default design skills (#604)', () => {
    const SKILLS = ['kit:guidelines', 'kit:frontend', 'kit:taste'];

    const setDefault = (defaultSkills: string[], session = h.admin) =>
      session.send('put', `/projects/${h.projectId}/design-settings`, {
        viewports: [{ name: 'Desktop', width: 1440, height: 900 }],
        defaultSkills,
      });

    beforeEach(async () => {
      await h.ctx.prisma.installedSkill.createMany({
        data: SKILLS.map((invocation) => ({
          runnerId: h.runnerId,
          scope: 'plugin' as const,
          runtime: 'claude',
          name: invocation.split(':')[1],
          invocation,
          path: `/home/u/.claude/skills/${invocation}`,
          seenAt: new Date(),
        })),
      });
    });

    it('a new design opens with the default, follows a later change of it, and generates with it', async () => {
      expect((await setDefault(SKILLS.slice(0, 2))).status).toBe(200);
      const card = await h.designedCard(1);
      expect(await h.cardDesign(card.number)).toMatchObject({
        skills: SKILLS.slice(0, 2),
        skillsEdited: false,
        defaultSkills: SKILLS.slice(0, 2),
      });

      await setDefault([SKILLS[2]]);
      expect((await h.cardDesign(card.number)).skills).toEqual([SKILLS[2]]);

      await h.seedProfile();
      expect((await generate(card.number)).status).toBe(201);
      const prompt = h.turnPrompts().at(-1) ?? '';
      expect(prompt).toContain(`\`${SKILLS[2]}\``);
      expect(prompt).not.toContain(SKILLS[0]);
      // Generated: a later change of the default no longer reaches it.
      await setDefault([SKILLS[0]]);
      await h.finishCard(card.id, designResult({ taskKey: KEY, variant: 1 }));
      expect((await h.cardDesign(card.number)).skills).toEqual([SKILLS[2]]);
    });

    it('a hand edit is kept when the default changes, and Use defaults follows it again', async () => {
      await setDefault([SKILLS[0]]);
      const card = await h.designedCard(1);
      const base = h.cardDesignBase(card.number);
      expect(
        (await h.author.send('patch', base, { skills: [SKILLS[1]] })).status,
      ).toBe(200);
      await setDefault([SKILLS[2]]);
      expect(await h.cardDesign(card.number)).toMatchObject({
        skills: [SKILLS[1]],
        skillsEdited: true,
        defaultSkills: [SKILLS[2]],
      });
      // A switch of the design alone is no hand edit of its skills.
      await h.author.send('patch', base, { variantCount: 2 });
      expect((await h.cardDesign(card.number)).skillsEdited).toBe(true);

      const both = await h.author.send('patch', base, {
        skills: [SKILLS[0]],
        useDefaultSkills: true,
      });
      expect(both.status).toBe(400);
      expect(
        (await h.author.send('patch', base, { useDefaultSkills: true })).status,
      ).toBe(200);
      expect(await h.cardDesign(card.number)).toMatchObject({
        skills: [SKILLS[2]],
        skillsEdited: false,
      });
      await setDefault([SKILLS[0]]);
      expect((await h.cardDesign(card.number)).skills).toEqual([SKILLS[0]]);
    });

    it('with no default a design has no skills until the default is set', async () => {
      const card = await h.designedCard(1);
      expect(await h.cardDesign(card.number)).toMatchObject({
        skills: [],
        skillsEdited: false,
        defaultSkills: [],
      });
      await setDefault([SKILLS[0]]);
      expect((await h.cardDesign(card.number)).skills).toEqual([SKILLS[0]]);
    });

    it('only a project admin saves the panel set as the default, audited like Settings → Design', async () => {
      expect((await setDefault(SKILLS, h.author)).status).toBe(403);
      expect((await setDefault(SKILLS, h.viewer)).status).toBe(403);
      expect(await h.auditOf('design.settings_updated')).toHaveLength(0);

      expect((await setDefault(SKILLS)).status).toBe(200);
      const [entry] = await h.auditOf('design.settings_updated');
      expect(entry.before).toMatchObject({ defaultSkills: [] });
      expect(entry.after).toMatchObject({ defaultSkills: SKILLS });
    });
  });

  describe('approve and continue (#273 D8, D9)', () => {
    /** A card whose one-variant design is drawn, with Continue after design `on`. */
    const reviewing = async (on: boolean) => {
      await h.seedProfile();
      const card = await h.designedCard(1);
      if (on) {
        const toggled = await h.author.send('patch', h.cardPath(card.number), {
          continueAfterDesign: true,
        });
        expect(toggled.status).toBe(200);
      }
      expect((await generate(card.number)).status).toBe(201);
      await h.finishCard(card.id, designResult({ taskKey: KEY, variant: 1 }));
      const [revision] = (await h.cardDesign(card.number)).revisions;
      return { card, revisionId: revision.id };
    };

    const approve = (number: number, revisionId: string) =>
      h.author.send('post', `${h.cardDesignBase(number)}/approve`, {
        revisionId,
      });

    const failure = async (number: number) =>
      (await h.author.get(h.cardPath(number))).body.autoRunFailure;

    it('with Continue off answers run: null', async () => {
      const { card, revisionId } = await reviewing(false);
      const answered = await approve(card.number, revisionId);
      expect(answered.status).toBe(200);
      expect(answered.body).toMatchObject({ status: 'approved', run: null });
      expect(h.cardSentOf('card.run')).toHaveLength(0);
    });

    it('with Continue on and room answers run: started', async () => {
      const { card, revisionId } = await reviewing(true);
      const answered = await approve(card.number, revisionId);
      expect(answered.status).toBe(200);
      expect(answered.body.run).toEqual({ status: 'started', round: 1 });
      expect(h.cardSentOf('card.run')).toHaveLength(1);
      expect(await failure(card.number)).toBeNull();
    });

    it('max_running: 200, approved, run_failed stored on the card; a later Run clears it', async () => {
      const { card, revisionId } = await reviewing(true);
      await h.ctx.prisma.boardSettings.upsert({
        where: { projectId: h.projectId },
        create: { projectId: h.projectId, maxRunning: 1 },
        update: { maxRunning: 1 },
      });
      const busy = await h.createCard({ title: 'Busy' });
      expect(
        (await h.author.send('post', `${h.cardPath(busy.number)}/run`, {}))
          .status,
      ).toBe(200);

      const answered = await approve(card.number, revisionId);
      expect(answered.status).toBe(200);
      expect(answered.body.status).toBe('approved');
      expect(answered.body.run).toMatchObject({
        status: 'run_failed',
        code: 'max_running',
      });
      expect(answered.body.run.message).toContain('1 of 1');
      expect(await failure(card.number)).toMatchObject({
        code: 'max_running',
      });
      const [audit] = await h.auditOf('card.auto_run_failed');
      expect(audit.after).toMatchObject({ error: 'max_running' });
      expect(audit.targetId).toBe(card.id);

      await h.ctx.prisma.boardSettings.update({
        where: { projectId: h.projectId },
        data: { maxRunning: 3 },
      });
      expect(
        (await h.author.send('post', `${h.cardPath(card.number)}/run`, {}))
          .status,
      ).toBe(200);
      expect(await failure(card.number)).toBeNull();
    });

    it('a hard-stop budget: run_failed with budget_exceeded', async () => {
      const { card, revisionId } = await reviewing(true);
      const check = jest.spyOn(h.ctx.app.get(BudgetGate), 'check');
      check.mockResolvedValue({
        allowed: false,
        budgetId: 'b1',
        scope: 'project',
        resetsAt: new Date('2026-11-01T00:00:00Z'),
      });
      const answered = await approve(card.number, revisionId);
      expect(answered.status).toBe(200);
      expect(answered.body.run).toMatchObject({
        status: 'run_failed',
        code: 'budget_exceeded',
      });
      expect(await failure(card.number)).toMatchObject({
        code: 'budget_exceeded',
      });
    });

    it('a runner without card.run: run_failed with command_unavailable', async () => {
      const { card, revisionId } = await reviewing(true);
      jest
        .mocked(h.boardCommands.assertReady)
        .mockImplementation((_runner, name) => {
          if (name === 'card.run') {
            throw new BoardFailure(
              503,
              BOARD_ERROR.commandUnavailable,
              'The runner does not serve card.run; update it',
            );
          }
        });
      const answered = await approve(card.number, revisionId);
      expect(answered.status).toBe(200);
      expect(answered.body.run).toEqual({
        status: 'run_failed',
        code: 'command_unavailable',
        message: 'The runner does not serve card.run; update it',
      });
      const stored = await h.ctx.prisma.boardCard.findUniqueOrThrow({
        where: { id: card.id },
        include: { rounds: true },
      });
      expect(stored.column).toBe('todo');
      expect(stored.rounds).toHaveLength(0);
      expect(stored.autoRunError).toBe('command_unavailable');

      // Switching the design off: the failure no longer applies.
      expect(
        (
          await h.author.send('patch', h.cardDesignBase(card.number), {
            needed: false,
          })
        ).status,
      ).toBe(200);
      expect(await failure(card.number)).toBeNull();
    });
  });
});
