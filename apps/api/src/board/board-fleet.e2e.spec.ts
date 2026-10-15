import type { RunnerEvent } from '@agentdock/shared/protocol';
import { BoardFleetService } from '../fleet/board-fleet.service';
import { EventStream, ROOT } from '../fleet/testing/fleet-e2e';
import {
  type CommandSendResult,
  RunnerCommandService,
} from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import { BoardWorld } from './testing/board-e2e';

const PR_URL = 'https://github.com/acme/widget/pull/7';
const BRIEF = `${ROOT}/.git/cs-orchestrator/2026-10-08/round-1430-i42.md`;

describe('board fleet mirror (e2e, #282 D4)', () => {
  const w = new BoardWorld();
  let fleet: BoardFleetService;
  let runnerSend: jest.SpyInstance;
  let stream: EventStream;

  const dispatch = (...events: RunnerEvent[]) =>
    w.sinks.dispatch(w.runnerId, events);

  const dispatched = (slot = 'i42', issue = 42, lead = true) =>
    stream.next(
      'slot.dispatched',
      {
        date: '2026-10-08',
        round: '1430',
        briefPath: BRIEF.replace('i42', slot),
        branch: `feat/${issue}-widget`,
        worktree: `/srv/dev/.wt-widget-${slot}`,
        model: 'opus',
        owns: [],
        never: [],
        lead,
      },
      { slot, issue, source: 'scraped' },
    );
  const appeared = (slot = 'i42') =>
    stream.next('session.appeared', { name: `cs-${slot}` }, { slot });
  const vanished = (slot = 'i42') =>
    stream.next('session.vanished', { name: `cs-${slot}` }, { slot });
  const prOpened = (slot = 'i42') =>
    stream.next(
      'pr.opened',
      {
        number: 7,
        branch: 'feat/42-widget',
        url: PR_URL,
        title: 'feat: widget',
        checks: 'pending',
      },
      { slot },
    );

  const fleetCards = () =>
    w.ctx.prisma.boardCard.findMany({
      where: { projectId: w.a, source: 'fleet' },
      orderBy: { number: 'asc' },
    });

  const move = (number: number, column: string) =>
    w.operator.send('post', `${w.path()}/board/cards/${number}/move`, {
      column,
      index: 0,
    });

  /** The issue is open and `cs:ready`: the queue holds a row for it. */
  const ready = async (number: number, title = 'Widget export') => {
    await w.ctx.prisma.issueCache.create({
      data: {
        projectId: w.a,
        number,
        title,
        state: 'open',
        labels: ['cs:ready'],
        assignees: [],
        body: 'Export widgets as CSV.',
        url: `https://github.com/acme/widget/issues/${number}`,
        ghUpdatedAt: new Date('2026-10-08T09:00:00Z'),
        snapshotAt: new Date('2026-10-08T09:00:00Z'),
        lastSeq: 0n,
      },
    });
    await w.ctx.prisma.queueStateRow.create({
      data: {
        projectId: w.a,
        issueNumber: number,
        state: 'ready',
        why: 'ready',
        source: 'computed',
        blockers: [],
        computedAt: new Date('2026-10-08T09:00:00Z'),
      },
    });
  };

  beforeAll(async () => {
    await w.init();
    fleet = w.ctx.app.get(BoardFleetService);
    jest
      .spyOn(w.ctx.app.get(RunnerPresence), 'isConnected')
      .mockReturnValue(true);
    runnerSend = jest
      .spyOn(w.ctx.app.get(RunnerCommandService), 'send')
      .mockImplementation(
        async (_runner, name): Promise<CommandSendResult<typeof name>> =>
          name === 'slot.message'
            ? {
                status: 'ok',
                output: { written: true, delivered: true },
                rttMs: 1,
              }
            : { status: 'error', error: { code: 'unknown_command' } },
      );
  });
  afterAll(() => w.close());
  beforeEach(async () => {
    await w.reset();
    runnerSend.mockClear();
    stream = new EventStream();
  });

  it('gives a dispatched slot one fleet card in In progress, and a replay adds none', async () => {
    const batch = [dispatched(), appeared()];
    await dispatch(...batch);
    await dispatch(...batch);

    const cards = await fleetCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      column: 'in_progress',
      fleetIssue: 42,
      fleetSlot: 'i42',
      fleetSlotGone: false,
      issueNumber: 42,
      branch: null,
    });

    const view = await w.operator.get(
      `${w.path()}/board/cards/${cards[0].number}`,
    );
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ source: 'fleet' });
  });

  it('moves the card to Finished when the slot opens its PR', async () => {
    await dispatch(dispatched(), appeared());
    await dispatch(prOpened());

    const [card] = await fleetCards();
    expect(card).toMatchObject({
      column: 'finished',
      prNumber: 7,
      prUrl: PR_URL,
      fleetStage: 'pr_open',
    });
  });

  it('refuses a person’s drag back to To Do with fleet_slot, and lets Finished → Completed through', async () => {
    await dispatch(dispatched(), appeared());
    const [running] = await fleetCards();

    const refused = await move(running.number, 'todo');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ reason: 'fleet_slot' });
    expect((await fleetCards())[0].column).toBe('in_progress');

    await dispatch(prOpened());
    const accepted = await move(running.number, 'completed');
    expect(accepted.status).toBe(200);
    expect((await fleetCards())[0].column).toBe('completed');
    // Accept never merges or closes a fleet card: the orchestrator merges.
    expect(w.sent('card.merge')).toHaveLength(0);
    expect(w.sent('card.close')).toHaveLength(0);
  });

  it('shows a cs:ready issue with no slot as one To Do card, which its lead slot takes over', async () => {
    await ready(42);
    await fleet.mirror(w.a);
    await fleet.mirror(w.a);

    const [todo, ...rest] = await fleetCards();
    expect(rest).toHaveLength(0);
    expect(todo).toMatchObject({
      column: 'todo',
      title: 'Widget export',
      body: 'Export widgets as CSV.',
      fleetIssue: 42,
      fleetSlot: null,
      issueUrl: 'https://github.com/acme/widget/issues/42',
    });

    await dispatch(dispatched('i42', 42, true), appeared('i42'));
    await dispatch(dispatched('i42b', 42, false));
    const cards = await fleetCards();
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      id: todo.id,
      fleetSlot: 'i42',
      column: 'in_progress',
    });
    expect(cards[1]).toMatchObject({ fleetSlot: 'i42b' });
  });

  it('keeps the column and marks the slot gone when its run ends unmerged', async () => {
    await dispatch(dispatched(), appeared());
    await dispatch(
      vanished(),
      stream.next(
        'worktree.changed',
        { path: '/srv/dev/.wt-widget-i42', exists: false },
        { slot: 'i42' },
      ),
    );

    const [card] = await fleetCards();
    expect(card).toMatchObject({ column: 'in_progress', fleetSlotGone: true });
  });

  it('never makes a card for a slot run that already ended', async () => {
    await dispatch(
      dispatched(),
      appeared(),
      vanished(),
      stream.next(
        'worktree.changed',
        { path: '/srv/dev/.wt-widget-i42', exists: false },
        { slot: 'i42' },
      ),
    );
    expect(await fleetCards()).toHaveLength(0);
  });

  describe('an edit of the card text', () => {
    const edit = async (body: string) => {
      const [card] = await fleetCards();
      const response = await w.operator.send(
        'patch',
        `${w.path()}/board/cards/${card.number}`,
        { body },
      );
      expect(response.status).toBe(200);
      // The edit is stored like any card's.
      expect((await fleetCards())[0].body).toBe(body);
      return card;
    };
    const slotMessages = () =>
      runnerSend.mock.calls.filter(([, name]) => name === 'slot.message');

    it('sends a running slot one slot.message worded from the change, and calls no GitHub command', async () => {
      await dispatch(dispatched(), appeared());
      const card = await edit('Also export as JSON.');

      const sent = slotMessages();
      expect(sent).toHaveLength(1);
      const [, , args] = sent[0];
      expect(args).toMatchObject({
        projectId: w.a,
        root: ROOT,
        slot: 'i42',
        from: 'op@x.test',
      });
      const text = (args as { text: string }).text;
      expect(text).toContain(`## Card C-${card.number} was edited`);
      expect(text).toContain('Also export as JSON.');
      expect(text).toContain('.orchestrator-reply.md');
      expect(text).not.toContain('finish_card');
      expect(
        runnerSend.mock.calls.filter(([, name]) =>
          String(name).startsWith('issue.'),
        ),
      ).toHaveLength(0);
      expect(w.issues()).toHaveLength(0);
    });

    it('cuts a long body so the message fits slot.message', async () => {
      await dispatch(dispatched(), appeared());
      await edit('é'.repeat(15_000));

      const [[, , args]] = slotMessages();
      const text = (args as { text: string }).text;
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024);
      expect(text).toContain('… (cut to fit)');
    });

    it('sends nothing to a slot whose session is not up', async () => {
      await dispatch(dispatched());
      await edit('Also export as JSON.');
      expect(slotMessages()).toHaveLength(0);
    });
  });
});
