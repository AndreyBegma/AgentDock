import { PLANNER_DISCUSS_CONTRACT, type PlanDetail } from '@nautelle/shared';
import { block, PlannerHarness } from './testing/planner-e2e';

/** #590 (ADR-0056): a discussion is a `discuss` plan — replies, maybe proposals, never a card. */

const OPENING =
  'Review how runner tokens are issued, stored and checked on the API side.';

const reply = (over: Record<string, unknown> = {}) => ({
  action: 'discuss',
  title: 'Security review of runner tokens',
  reply: '## Runner tokens\n\nThe guard compares hashes with `===`.',
  ...over,
});

const PROPOSALS = [
  {
    title: 'Compare runner token hashes in constant time',
    brief:
      'Replace the string equality in the runner auth guard with a constant-time comparison.',
  },
  {
    title: 'Rotate runner tokens',
    brief: 'Add a rotate action on the runner page.',
  },
];

describe('discussions (e2e, #590)', () => {
  const h = new PlannerHarness();

  beforeAll(() => h.start());
  afterAll(() => h.ctx.app.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  const installed = (invocation: string) =>
    h.ctx.prisma.installedSkill.create({
      data: {
        runnerId: h.runnerId,
        scope: 'plugin',
        runtime: 'claude',
        name: invocation.split(':').at(-1) ?? invocation,
        invocation,
        path: `/home/u/.claude/skills/${invocation}`,
        seenAt: new Date(),
      },
    });

  const start = async (body: Record<string, unknown> = {}) => {
    const response = await h.author.send('post', h.base(), {
      brief: OPENING,
      mode: 'discuss',
      ...body,
    });
    expect(response.status).toBe(201);
    return response.body as PlanDetail;
  };

  const turn = (planId: string, body: object) =>
    h.author.send('post', `${h.base(planId)}/turns`, body);

  const prompts = () =>
    h.sentOf('plan.turn').map((args) => String(args.prompt));

  it('starts a discussion with its skills, and its first turn answers the opening', async () => {
    await installed('code-sentinel:cs-security');
    const plan = await start({
      skills: ['code-sentinel:cs-security', 'code-sentinel:cs-gone'],
    });
    expect(plan).toMatchObject({
      mode: 'discuss',
      status: 'clarifying',
      intake: null,
      discussion: {
        skills: ['code-sentinel:cs-security', 'code-sentinel:cs-gone'],
      },
    });
    const stored = await h.ctx.prisma.plan.findUniqueOrThrow({
      where: { id: plan.id },
    });
    expect(stored.skills).toEqual([
      'code-sentinel:cs-security',
      'code-sentinel:cs-gone',
    ]);
    const [turnRow] = await h.ctx.prisma.planTurn.findMany({
      where: { planId: plan.id },
    });
    expect(turnRow.action).toBe('discuss');
    const prompt = prompts()[0];
    expect(prompt.startsWith('# Discussion')).toBe(true);
    expect(prompt).toContain(PLANNER_DISCUSS_CONTRACT.trim());
    expect(prompt).toContain(OPENING);
    expect(prompt).toContain('Never edit, create or delete a file');
    // Only an installed skill reaches the turn.
    expect(prompt).toContain('`code-sentinel:cs-security`');
    expect(prompt).not.toContain('cs-gone');
    // The person's words are kept as typed.
    expect(await h.ctx.prisma.textNormalization.count()).toBe(0);
  });

  it('refuses skills on another mode', async () => {
    const response = await h.author.send('post', h.base(), {
      brief: 'Build it',
      mode: 'card',
      skills: ['code-sentinel:cs-security'],
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('wrong_mode');
  });

  it('stores a reply, retitles the discussion, and takes any number of messages without making a card', async () => {
    const plan = await start();
    await h.finish(plan.id, block(reply()));
    const answered = await h.detail(plan.id);
    expect(answered.title).toBe('Security review of runner tokens');
    expect(answered.status).toBe('clarifying');
    expect(answered.turns[0]).toMatchObject({
      phase: 'succeeded',
      reply: {
        reply: '## Runner tokens\n\nThe guard compares hashes with `===`.',
        proposals: [],
      },
    });

    for (let i = 1; i <= 5; i += 1) {
      const sent = await turn(plan.id, { message: `Question ${i}?` });
      expect(sent.status).toBe(201);
      expect(prompts()[i]).toContain(`Question ${i}?`);
      await h.finish(
        plan.id,
        block({ action: 'discuss', reply: `Answer ${i}.` }),
      );
    }
    const later = await h.detail(plan.id);
    expect(later.turns).toHaveLength(6);
    expect(later.turns.every((t) => t.phase === 'succeeded')).toBe(true);
    expect(later.turns.at(-1)?.input).toEqual({ message: 'Question 5?' });
    expect(later.title).toBe('Security review of runner tokens');
    expect(
      await h.ctx.prisma.boardCard.count({ where: { planId: plan.id } }),
    ).toBe(0);
  });

  it('keeps the proposed cards of a reply, and makes none', async () => {
    const plan = await start();
    await h.finish(plan.id, block(reply({ proposals: PROPOSALS })));
    const detail = await h.detail(plan.id);
    expect(detail.turns[0].reply?.proposals).toEqual(PROPOSALS);
    expect(
      await h.ctx.prisma.boardCard.count({ where: { planId: plan.id } }),
    ).toBe(0);
    const cards = await h.author.send('post', `${h.base(plan.id)}/cards`);
    expect(cards.status).toBe(409);
    expect(cards.body.error).toBe('wrong_mode');
  });

  it('fails a malformed turn with a contract violation and changes nothing', async () => {
    const plan = await start();
    await h.finish(
      plan.id,
      block({
        action: 'discuss',
        title: 'Renamed',
        reply: 'One thing.',
        proposals: [{ title: 'Fix it' }],
      }),
    );
    const detail = await h.detail(plan.id);
    expect(detail.title).not.toBe('Renamed');
    expect(detail.turns[0]).toMatchObject({ phase: 'failed', reply: null });
    expect(detail.turns[0].error).toMatch(/^contract_violation: invalid_shape/);
    expect(detail.turns[0].resultText).toContain('Fix it');

    // Retry runs the same turn again.
    const retried = await h.author.send(
      'post',
      `${h.base(plan.id)}/turns/${detail.turns[0].id}/retry`,
    );
    expect(retried.status).toBe(201);
    await h.finish(plan.id, block(reply()));
    const fixed = await h.detail(plan.id);
    expect(fixed.turns.map((t) => t.phase)).toEqual(['failed', 'succeeded']);
  });

  it('needs a message after the first turn, and refuses intake inputs', async () => {
    const plan = await start();
    await h.finish(plan.id, block(reply()));
    const empty = await turn(plan.id, {});
    expect(empty.status).toBe(400);
    const generate = await turn(plan.id, { message: 'Go', generate: true });
    expect(generate.status).toBe(409);
    expect(generate.body.error).toBe('wrong_mode');
  });

  it('archives a discussion on Discard, which then takes no turn', async () => {
    const plan = await start();
    await h.finish(plan.id, block(reply()));
    const archived = await h.author.send('post', `${h.base(plan.id)}/archive`);
    expect(archived.status).toBe(200);
    const detail = await h.detail(plan.id);
    expect(detail.status).toBe('archived');
    const after = await turn(plan.id, { message: 'Still there?' });
    expect(after.status).toBe(409);
    expect(after.body.error).toBe('plan_closed');
  });
});
