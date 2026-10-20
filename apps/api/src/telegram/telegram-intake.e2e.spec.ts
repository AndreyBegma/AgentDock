import { PLANNER_BLOCK_TAG } from '@nautelle/shared';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { BotTokenStore } from '../notifications';
import {
  seedRunnerProject,
  seedUser,
} from '../notifications/testing/notifications-e2e';
import { PlanService } from '../planner/plan.service';
import { PlannerCommands } from '../planner/planner-commands';
import { RunnerEventSinks } from '../runners/runner-event-sinks';
import { RunnerPresence } from '../runners/runner-presence';
import type { InlineKeyboardButton } from './telegram-client';
import {
  INTAKE_REPLIES,
  TelegramIntakeService,
} from './telegram-intake.service';
import { TelegramPoller } from './telegram-poller';
import {
  BOT,
  BOT_TOKEN,
  callbackPress,
  type FakeCall,
  FakeTelegram,
  privateMessage,
  replyMessage,
} from './testing/fake-telegram';
import {
  createTelegramApp,
  resetTelegram,
  type TelegramE2e,
} from './testing/telegram-e2e';

const CHAT = 7101;
const VIEWER_CHAT = 7102;
const UNLINKED_CHAT = 7999;
const ROOT = '/srv/dev/widget';
const REPO = 'acme/widget';
const BRIEF = 'Add CSV export';

const block = (output: object): string =>
  `Here is the result.\n\n\`\`\`${PLANNER_BLOCK_TAG}\n${JSON.stringify(output)}\n\`\`\`\n`;

const fields = (multiple = false) => ({
  id: multiple ? 'fields' : 'format',
  title: multiple ? 'Which fields' : 'File format',
  question: multiple
    ? 'Which fields go into the export?'
    : 'Which delimiter does the file use?',
  options: multiple
    ? [
        { id: 'title', label: 'Title' },
        { id: 'column', label: 'Column' },
        { id: 'cost', label: 'Cost' },
      ]
    : [
        { id: 'comma', label: 'Comma' },
        { id: 'semicolon', label: 'Semicolon' },
      ],
  ...(multiple ? { multiple: true } : {}),
  recommendation: multiple
    ? { optionId: 'title', text: 'Title', why: 'It is the minimum.' }
    : { optionId: 'comma', text: 'Comma', why: 'Spreadsheets expect it.' },
  blocking: false,
});

const ROUND = { action: 'intake', questions: [fields(), fields(true)] };

const cardBody = (what: string) =>
  [
    '## What to do',
    '',
    `${what} for the people who use the board every day.`,
    '',
    '## Acceptance criteria',
    '',
    '- [ ] The change works on the board and is covered by a test.',
    '',
    '## Out of scope',
    '',
    'None.',
    '',
    '## Open questions',
    '',
    'None.',
  ].join('\n');

const CARD = {
  action: 'intake',
  cardDraft: {
    title: 'Export the board as CSV',
    kind: 'feature',
    body: cardBody('Export the board as CSV'),
  },
};

const splitCard = (title: string, kind: 'bug' | 'feature' = 'feature') => ({
  title,
  kind,
  summary: `${title}, on its own card.`,
  body: cardBody(title),
});

const SPLIT = {
  action: 'intake',
  split: {
    reason: 'SECRET REASON PROSE',
    cards: [
      splitCard('Export the board as CSV'),
      splitCard('Fix the sign-in button on mobile', 'bug'),
    ],
  },
};

const STACK_BODY =
  'The export of the board comes in two parts: first the service that writes the file, then the button that people press.';

const STACK = {
  action: 'intake',
  stack: {
    reason: 'SECRET REASON PROSE',
    title: 'Board export',
    body: STACK_BODY,
    design: false,
    stages: [
      { title: 'Foundations', cards: [splitCard('Add the export service')] },
      { title: 'Features', cards: [splitCard('Add the export button')] },
    ],
  },
};

describe('Telegram /new: the New work intake (e2e, #574)', () => {
  let ctx: TelegramE2e;
  let fake: FakeTelegram;
  let nextUpdate = 1;
  let adaId: string;
  let projectId: string;
  let runnerId: string;
  let seq = 0;
  /** What the stubbed runner was sent as `plan.turn`. */
  let turnsSent: Record<string, unknown>[] = [];
  let connected = true;

  const poller = () => ctx.app.get(TelegramPoller);
  const intake = () => ctx.app.get(TelegramIntakeService);

  /** Feeds `updates` through one poll; the calls Telegram got meanwhile. */
  const poll = async (...updates: { update_id: number }[]) => {
    const before = ctx.fake.calls.length;
    ctx.fake.updates = updates;
    await poller().pollOnce();
    await intake().idle();
    return ctx.fake.calls.slice(before);
  };
  const sends = (calls: FakeCall[]) =>
    calls.filter((c) => c.method === 'sendMessage').map((c) => c.body);
  const edits = (calls: FakeCall[]) =>
    calls.filter((c) => c.method === 'editMessageText').map((c) => c.body);
  const notices = (calls: FakeCall[]) =>
    calls
      .filter((c) => c.method === 'answerCallbackQuery')
      .map((c) => c.body.text);
  const say = (chatId: number, text: string) =>
    poll(privateMessage(nextUpdate++, chatId, text));
  const press = (data: string, messageId: number, chatId = CHAT) =>
    poll(callbackPress(nextUpdate++, chatId, data, messageId));

  const buttons = (body: Record<string, unknown> | undefined) =>
    (
      (body?.reply_markup as { inline_keyboard: InlineKeyboardButton[][] })
        ?.inline_keyboard ?? []
    ).flat();
  const button = (body: Record<string, unknown> | undefined, text: string) => {
    const found = buttons(body).find((b) => b.text === text);
    if (!found) throw new Error(`no button "${text}"`);
    return found.callback_data;
  };

  /** The message id the fake gave the `index`-th send of `calls`. */
  const sentIds = (calls: FakeCall[]) => {
    const ids: number[] = [];
    for (const call of calls) {
      if (call.method === 'sendMessage') {
        ids.push(ctx.fake.calls.indexOf(call) + 1);
      }
    }
    return ids;
  };

  const planOf = () =>
    ctx.prisma.plan.findFirstOrThrow({ where: { projectId, mode: 'card' } });
  const activeTurn = (planId: string) =>
    ctx.prisma.planTurn.findFirstOrThrow({
      where: { planId, phase: { in: ['queued', 'running'] } },
    });

  /** The runner reports the active turn finished with `output`. */
  const finish = async (
    planId: string,
    output: object | null,
    phase: 'succeeded' | 'failed' = 'succeeded',
  ) => {
    const turn = await activeTurn(planId);
    seq += 1;
    const before = ctx.fake.calls.length;
    await ctx.app.get(RunnerEventSinks).dispatch(runnerId, [
      {
        v: 1,
        seq,
        ts: new Date().toISOString(),
        type: 'plan_turn.finished',
        source: 'runner',
        project: { repo: REPO, root: ROOT },
        data: {
          planId,
          turnId: turn.id,
          runId: turn.runId,
          projectId,
          phase,
          at: new Date().toISOString(),
          exitCode: phase === 'failed' ? 1 : 0,
          resultText: output ? block(output) : 'PANE TEXT of a crash',
          resultTruncated: false,
        },
      },
    ]);
    await intake().idle();
    return ctx.fake.calls.slice(before);
  };

  /** `/new` with the brief, then the round opened. */
  const startRound = async () => {
    await say(CHAT, `/new ${BRIEF}`);
    const plan = await planOf();
    const calls = await finish(plan.id, ROUND);
    const ids = sentIds(calls);
    const [single, multiple, controls] = sends(calls);
    return {
      plan,
      calls,
      single: { body: single, id: ids[0] },
      multiple: { body: multiple, id: ids[1] },
      controls: { body: controls, id: ids[2] },
    };
  };

  beforeAll(async () => {
    fake = await FakeTelegram.start();
    ctx = await createTelegramApp(undefined, fake);
  });
  afterAll(async () => {
    await ctx.close();
    await fake.close();
  });
  afterEach(() => jest.restoreAllMocks());

  beforeEach(async () => {
    await resetTelegram(ctx.prisma);
    await ctx.prisma.plannerInstructions.deleteMany({});
    ctx.fake.reset();
    seq = 0;
    turnsSent = [];
    connected = true;
    const root = await seedUser(ctx.prisma, 'root@example.com', 'admin');
    await ctx.app
      .get(BotTokenStore)
      .set(BOT_TOKEN, 'agentdock_bot', root.id, { actor: SYSTEM_ACTOR });
    await ctx.prisma.notificationMatcherState.create({
      data: { id: 1, eventsCursor: 0n },
    });
    ({ runnerId, projectId } = await seedRunnerProject(ctx.prisma, {
      root: ROOT,
      repo: REPO,
    }));
    const profile = await ctx.prisma.runtimeProfile.create({
      data: {
        runnerId,
        key: 'claude-main',
        runtime: 'claude',
        label: 'Claude',
        env: {},
        args: [],
        authenticated: true,
      },
    });
    await ctx.prisma.project.update({
      where: { id: projectId },
      data: { defaultProfileId: profile.id },
    });
    await ctx.prisma.plannerInstructions.create({
      data: { projectId: null, version: 1, body: 'GLOBAL INSTRUCTIONS v1' },
    });
    adaId = (
      await seedUser(ctx.prisma, 'ada@example.com', 'operator', projectId)
    ).id;
    const vic = await seedUser(
      ctx.prisma,
      'vic@example.com',
      'viewer',
      projectId,
    );
    await ctx.prisma.telegramLink.createMany({
      data: [
        { userId: adaId, chatId: BigInt(CHAT) },
        { userId: vic.id, chatId: BigInt(VIEWER_CHAT) },
      ],
    });

    const presence = ctx.app.get(RunnerPresence);
    jest.spyOn(presence, 'isConnected').mockImplementation(() => connected);
    jest.spyOn(presence, 'missingCommand').mockReturnValue(null);
    jest
      .spyOn(ctx.app.get(PlannerCommands), 'send')
      .mockImplementation(async (_runner, name, args) => {
        if (name === 'plan.turn') {
          turnsSent.push(args as Record<string, unknown>);
          return { status: 'ok', output: { phase: 'queued' } } as never;
        }
        if (name === 'plan.cancel') {
          return { status: 'ok', output: { cancelled: true } } as never;
        }
        return { status: 'ok', output: { removed: true } } as never;
      });
  });

  it('starts a card plan from /new <text> that the web Board’s drafts list, and shows one thinking message', async () => {
    const calls = await say(CHAT, `/new ${BRIEF}`);
    const plan = await planOf();
    expect(plan).toMatchObject({
      mode: 'card',
      authorId: adaId,
      brief: BRIEF,
      status: 'clarifying',
    });
    const drafts = await ctx.app.get(PlanService).list(projectId, adaId);
    expect(drafts.items.map((p) => p.id)).toEqual([plan.id]);
    expect(sends(calls).map((b) => b.text)).toEqual([
      'Thinking…',
      'widget · New work started. It is in the Board’s drafts too.',
    ]);
    expect(turnsSent).toHaveLength(1);
  });

  it('takes the description as the next message after a bare /new', async () => {
    const asked = sends(await say(CHAT, '/new'));
    expect(asked[0]?.text).toBe(`widget · ${INTAKE_REPLIES.describe}`);
    expect(asked[0]?.reply_markup).toMatchObject({ force_reply: true });
    expect(await ctx.prisma.plan.count()).toBe(0);

    await poll(
      replyMessage(nextUpdate++, CHAT, BRIEF, asked[0]?.text as string, {
        id: BOT.id,
        is_bot: true,
      }),
    );
    expect((await planOf()).brief).toBe(BRIEF);
    // The next text is not a description any more.
    await say(CHAT, 'something else');
    expect(await ctx.prisma.plan.count()).toBe(1);
  });

  it('says the runner is offline and starts nothing', async () => {
    connected = false;
    const [answer] = sends(await say(CHAT, `/new ${BRIEF}`));
    expect(answer?.text).toMatch(/^widget · The project’s runner is offline/);
    expect(await ctx.prisma.plan.count()).toBe(0);
    expect(await ctx.prisma.telegramIntake.count()).toBe(0);
  });

  it('refuses a viewer and an unlinked chat', async () => {
    const [viewer] = sends(await say(VIEWER_CHAT, `/new ${BRIEF}`));
    expect(viewer?.text).toBe(
      'Your role on this project does not allow that, so nothing changed.',
    );
    const [unlinked] = sends(await say(UNLINKED_CHAT, `/new ${BRIEF}`));
    expect(unlinked?.text).toMatch(/not linked/);
    expect(await ctx.prisma.plan.count()).toBe(0);
  });

  it('shows a round as one message per question, with the recommendation and options, under the edited thinking message', async () => {
    const { calls, single, multiple, controls } = await startRound();
    expect(edits(calls).map((b) => b.text)).toEqual([
      'Round 1 of 4: 2 questions\\.',
    ]);
    expect(single.body?.text).toContain('*1/2 · File format*');
    expect(single.body?.text).toContain('Which delimiter does the file use?');
    expect(single.body?.text).toContain(
      '_Recommended: Comma_ — Spreadsheets expect it\\.',
    );
    expect(buttons(single.body).map((b) => b.text)).toEqual([
      'Comma ★',
      'Semicolon',
    ]);
    expect(buttons(multiple.body).map((b) => b.text)).toEqual([
      'Title ★',
      'Column',
      'Cost',
      'Done',
    ]);
    expect(buttons(controls.body).map((b) => b.text)).toEqual([
      'Send answers',
      'Enough — generate',
      'Discard',
    ]);
  });

  it('takes several options before Done, a reply as an own answer, and sends the round', async () => {
    const { plan, single, multiple, controls } = await startRound();
    const column = button(multiple.body, 'Column');
    const cost = button(multiple.body, 'Cost');
    await press(column, multiple.id);
    const toggled = edits(await press(cost, multiple.id));
    expect(buttons(toggled[0]).map((b) => b.text)).toEqual([
      'Title ★',
      '✓ Column',
      '✓ Cost',
      'Done',
    ]);
    const done = await press(button(multiple.body, 'Done'), multiple.id);
    expect(edits(done)[0]?.text).toContain('Picked: Column, Cost');

    const replied = await poll(
      replyMessage(
        nextUpdate++,
        CHAT,
        'Tabs, please',
        String(single.body?.text),
        { id: BOT.id, is_bot: true },
        single.id,
      ),
    );
    expect(sends(replied)[0]?.text).toBe(INTAKE_REPLIES.answered);

    const sent = await press(
      button(controls.body, 'Send answers'),
      controls.id,
    );
    expect(notices(sent)).toEqual(['Answers sent.']);
    expect(sends(sent).map((b) => b.text)).toEqual(['Thinking…']);
    expect((await activeTurn(plan.id)).input).toEqual({
      answers: [
        { questionId: 'format', text: 'Tabs, please' },
        { questionId: 'fields', optionIds: ['column', 'cost'] },
      ],
    });
  });

  it('fills unanswered questions with their recommendations on Send answers', async () => {
    const { plan, controls } = await startRound();
    await press(button(controls.body, 'Send answers'), controls.id);
    expect((await activeTurn(plan.id)).input).toEqual({
      answers: [
        { questionId: 'format', optionId: 'comma' },
        { questionId: 'fields', optionId: 'title' },
      ],
    });
  });

  it('Enough — generate writes one candidate, announced with its kind and a link to Drafts (#592)', async () => {
    const { plan, controls } = await startRound();
    await press(button(controls.body, 'Enough — generate'), controls.id);
    expect((await activeTurn(plan.id)).input).toMatchObject({ generate: true });
    const calls = await finish(plan.id, CARD);
    expect(
      await ctx.prisma.boardCard.count({ where: { planId: plan.id } }),
    ).toBe(0);
    const [shown] = edits(calls);
    expect(shown?.text).toContain('*A card waits for you*');
    expect(shown?.text).toContain('Export the board as CSV · feature');
    expect(shown?.text).toContain(
      `(https://dock.example.com/projects/${projectId}/board)`,
    );
    expect(await ctx.prisma.telegramIntake.count()).toBe(0);
  });

  it('lists a split with summaries, sends all its cards to Drafts, and offers Open in app', async () => {
    await say(CHAT, `/new ${BRIEF}`);
    const plan = await planOf();
    const calls = await finish(plan.id, SPLIT);
    const [shown] = edits(calls);
    const thinkingId = Number(shown?.message_id);
    expect(shown?.text).toContain('*2 cards proposed*');
    expect(shown?.text).toContain(
      '• Fix the sign\\-in button on mobile \\(bug\\) — Fix the sign\\-in button on mobile, on its own card\\.',
    );
    expect(shown?.text).toContain(
      `[Open in app](https://dock.example.com/projects/${projectId}/board?intake=${plan.id})`,
    );
    expect(buttons(shown).map((b) => b.text)).toEqual([
      'Create all',
      'Keep one card',
      'Discard',
    ]);
    const created = await press(button(shown, 'Create all'), thinkingId);
    expect(notices(created)).toEqual(['Sending the cards to Drafts.']);
    const candidates = await ctx.prisma.planCandidate.findMany({
      where: { planId: plan.id },
      orderBy: { position: 'asc' },
    });
    expect(candidates.map((c) => c.title)).toEqual([
      'Export the board as CSV',
      'Fix the sign-in button on mobile',
    ]);
    expect(
      await ctx.prisma.boardCard.count({ where: { planId: plan.id } }),
    ).toBe(0);
    const announced = sends(created).map((b) => String(b.text));
    expect(announced.at(-1)).toContain('*2 cards wait for you*');
  });

  it('sends a proposed stack to Drafts with its stages', async () => {
    await say(CHAT, `/new ${BRIEF}`);
    const plan = await planOf();
    const [shown] = edits(await finish(plan.id, STACK));
    expect(shown?.text).toContain('*A stack of 2 cards: Board export*');
    expect(shown?.text).toContain('_Stage 1: Foundations_');
    await press(button(shown, 'Create all'), Number(shown?.message_id));
    const candidates = await ctx.prisma.planCandidate.findMany({
      where: { planId: plan.id },
      orderBy: { position: 'asc' },
    });
    expect(candidates.map((c) => c.stage)).toEqual([0, 1]);
    expect(
      await ctx.prisma.boardStack.count({ where: { planId: plan.id } }),
    ).toBe(0);
  });

  it('Keep one card on a split yields one candidate', async () => {
    await say(CHAT, `/new ${BRIEF}`);
    const plan = await planOf();
    const [shown] = edits(await finish(plan.id, SPLIT));
    await press(button(shown, 'Keep one card'), Number(shown?.message_id));
    expect((await activeTurn(plan.id)).input).toEqual({ keepOne: true });
    await finish(plan.id, CARD);
    expect(
      await ctx.prisma.planCandidate.count({ where: { planId: plan.id } }),
    ).toBe(1);
  });

  it('offers Retry and Cancel on a failed turn, and both work', async () => {
    await say(CHAT, `/new ${BRIEF}`);
    const plan = await planOf();
    const [failed] = edits(await finish(plan.id, null, 'failed'));
    expect(failed?.text).toBe(
      'The planner turn failed\\. Retry it, or Cancel to discard this intake\\.',
    );
    expect(buttons(failed).map((b) => b.text)).toEqual(['Retry', 'Cancel']);

    const retried = await press(
      button(failed, 'Retry'),
      Number(failed?.message_id),
    );
    expect(notices(retried)).toEqual(['Retrying.']);
    expect(turnsSent).toHaveLength(2);
    await activeTurn(plan.id);

    const [again] = edits(await finish(plan.id, null, 'failed'));
    const cancelled = await press(
      button(again, 'Cancel'),
      Number(again?.message_id),
    );
    expect(notices(cancelled)).toEqual(['Discarded.']);
    expect((await planOf()).status).toBe('archived');
    expect(await ctx.prisma.telegramIntake.count()).toBe(0);
    // The old buttons do nothing now.
    const stale = await press(
      button(failed, 'Retry'),
      Number(failed?.message_id),
    );
    expect(notices(stale)).toEqual([INTAKE_REPLIES.over]);
  });

  it('refuses a button of a message that is not the intake’s current one', async () => {
    const { controls, single } = await startRound();
    const wrong = await press(button(controls.body, 'Send answers'), single.id);
    expect(notices(wrong)).toEqual([INTAKE_REPLIES.invalidButton]);
    expect(turnsSent).toHaveLength(1);
  });

  it('sends nothing to Telegram beyond questions, card titles and summaries (D10)', async () => {
    const { plan, controls } = await startRound();
    await press(button(controls.body, 'Enough — generate'), controls.id);
    const [failed] = edits(await finish(plan.id, null, 'failed'));
    await press(button(failed, 'Retry'), Number(failed?.message_id));
    await finish(plan.id, STACK);
    const all = JSON.stringify(ctx.fake.calls.map((c) => c.body));
    for (const secret of [
      BRIEF,
      'GLOBAL INSTRUCTIONS',
      'New work intake instructions',
      'Here is the result',
      'PANE TEXT',
      'SECRET REASON PROSE',
      STACK_BODY,
      PLANNER_BLOCK_TAG,
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});
