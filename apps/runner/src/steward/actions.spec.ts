import { describe, expect, it } from 'bun:test';
import {
  STEWARD_ACTED_EVENT,
  STEWARD_NUDGE_TEXT,
  type StewardActedData,
  type StewardRunnerConfig,
} from '@nautelle/shared';
import {
  type CardResumeArgs,
  type CardResumeResult,
  parseCommand,
  type UnsequencedEvent,
  type WatchedProject,
} from '@nautelle/shared/protocol';
import type { CardRecord } from '../cards/record';
import { CommandFailure } from '../commands/failure';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger } from '../testing/fixtures';
import { StewardActions } from './actions';

const steward: StewardRunnerConfig = {
  enabled: true,
  silenceMinutes: 10,
  trailerGuard: true,
};

const RECORD: CardRecord = {
  cardId: 'card_1',
  projectId: 'prj_widget',
  root: '/home/dev/widget',
  repo: 'widget',
  shortId: 'ab12cd34',
  worktree: '/home/dev/.wt-widget-card-ab12cd34',
  branch: 'card/c12-export-csv',
  base: 'main',
  tmuxSession: 'agentdock-card-ab12cd34',
  runId: 'run_1',
  phase: 'running',
  startedAt: '2026-10-16T12:00:00.000Z',
};

const RESUME: CardResumeArgs = {
  cardId: 'card_1',
  projectId: 'prj_widget',
  runId: 'run_1',
  root: '/home/dev/widget',
  base: 'main',
  shortId: 'ab12cd34',
  branch: 'card/c12-export-csv',
  sessionId: '3bb1739e-1a1c-4baa-b8b4-a4b1e6700361',
  profileKey: 'claude-work',
  model: 'opus',
  permissionMode: 'acceptEdits',
};

const subject = {
  kind: 'card_round' as const,
  cardId: 'card_1',
  runId: 'run_1',
};

const setup = (
  options: {
    project?: Partial<WatchedProject>;
    idle?: boolean;
    dialogShown?: string | null;
    live?: boolean;
    resume?: CardResumeResult['outcome'];
  } = {},
) => {
  const events: UnsequencedEvent[] = [];
  const typed: { session: string; text: string }[] = [];
  const keys: string[] = [];
  const resumed: string[] = [];
  const project: WatchedProject = {
    id: 'prj_widget',
    root: '/home/dev/widget',
    steward,
    ...options.project,
  };
  const actions = new StewardActions({
    cards: {
      record: (cardId) => (cardId === 'card_1' ? RECORD : null),
      liveSession: () =>
        options.live === false ? null : 'agentdock-card-ab12cd34',
      typeAtPrompt: async (session, text) => {
        if (options.idle === false) return false;
        typed.push({ session, text });
        return true;
      },
      dismissDialog: async (session, dialogId) => {
        const shown =
          options.dialogShown === undefined
            ? 'teach-auto-mode'
            : options.dialogShown;
        if (shown !== dialogId) {
          return false;
        }
        keys.push(`${session}:${dialogId}`);
        return true;
      },
      resume: async (args): Promise<CardResumeResult> => {
        const outcome = options.resume ?? 'resumed';
        return outcome === 'no_worktree'
          ? { outcome }
          : { outcome, tmuxSession: `agentdock-card-${args.shortId}` };
      },
    },
    watchedProjects: () => [project],
    emit: (event) => events.push(event),
    clock: new FakeClock(Date.parse('2026-10-16T12:00:00.000Z')),
    log: memoryLogger().log,
    onResumed: (s) => resumed.push(s.runId),
  });
  const acted = () =>
    events
      .filter((e) => e.type === STEWARD_ACTED_EVENT)
      .map((e) => e.data as StewardActedData);
  const failure = async (work: Promise<unknown>) =>
    work.then(
      () => 'resolved',
      (error: unknown) =>
        error instanceof CommandFailure ? error.code : String(error),
    );
  return { actions, events, typed, keys, resumed, acted, failure };
};

describe('session.nudge (#447 D9)', () => {
  it('types the one fixed line into the subject’s session and records it', async () => {
    const t = setup();
    expect(
      await t.actions.nudge({
        projectId: 'prj_widget',
        subject,
        text: STEWARD_NUDGE_TEXT,
      }),
    ).toEqual({ sent: true });
    expect(t.typed).toEqual([
      { session: 'agentdock-card-ab12cd34', text: STEWARD_NUDGE_TEXT },
    ]);
    expect(t.acted()).toEqual([
      expect.objectContaining({ action: 'nudge', result: 'ok', subject }),
    ]);
  });

  it('types nothing when the pane is not at an idle prompt', async () => {
    const t = setup({ idle: false });
    expect(
      await t.actions.nudge({
        projectId: 'prj_widget',
        subject,
        text: STEWARD_NUDGE_TEXT,
      }),
    ).toEqual({ sent: false });
    expect(t.acted()).toEqual([
      expect.objectContaining({
        action: 'nudge',
        result: 'failed',
        detail: 'the session was not at an idle prompt',
      }),
    ]);
  });

  it('refuses a third nudge of the round itself, whatever the API sends', async () => {
    const t = setup();
    const nudge = () =>
      t.actions.nudge({
        projectId: 'prj_widget',
        subject,
        text: STEWARD_NUDGE_TEXT,
      });
    await nudge();
    await nudge();
    expect(await t.failure(nudge())).toBe('busy');
    expect(t.typed).toHaveLength(2);
  });

  it('takes no other text and no fleet slot: the schema refuses them', () => {
    expect(
      parseCommand('session.nudge', {
        projectId: 'prj_widget',
        subject,
        text: 'rm -rf /',
      }).ok,
    ).toBe(false);
    expect(
      parseCommand('session.nudge', {
        projectId: 'prj_widget',
        subject: { kind: 'fleet_slot', slot: 'i447-api' },
        text: STEWARD_NUDGE_TEXT,
      }).ok,
    ).toBe(false);
  });

  it('refuses another round, an unwatched project and Steward off', async () => {
    const other = setup();
    expect(
      await other.failure(
        other.actions.nudge({
          projectId: 'prj_widget',
          subject: { ...subject, runId: 'run_0' },
          text: STEWARD_NUDGE_TEXT,
        }),
      ),
    ).toBe('not_found');
    expect(
      await other.failure(
        other.actions.nudge({
          projectId: 'prj_other',
          subject,
          text: STEWARD_NUDGE_TEXT,
        }),
      ),
    ).toBe('path_not_allowed');
    const off = setup({ project: { steward: { ...steward, enabled: false } } });
    expect(
      await off.failure(
        off.actions.nudge({
          projectId: 'prj_widget',
          subject,
          text: STEWARD_NUDGE_TEXT,
        }),
      ),
    ).toBe('unsupported');
    expect([...other.typed, ...off.typed]).toEqual([]);
  });
});

describe('session.dismiss (#447 D11)', () => {
  it('answers the listed dialog the pane shows', async () => {
    const t = setup();
    expect(
      await t.actions.dismiss({
        projectId: 'prj_widget',
        subject,
        dialogId: 'teach-auto-mode',
      }),
    ).toEqual({ dismissed: true });
    expect(t.keys).toEqual(['agentdock-card-ab12cd34:teach-auto-mode']);
    expect(t.acted()).toEqual([
      expect.objectContaining({ action: 'dismiss', result: 'ok' }),
    ]);
  });

  it('sends nothing when the pane no longer shows it', async () => {
    const t = setup({ dialogShown: null });
    expect(
      await t.actions.dismiss({
        projectId: 'prj_widget',
        subject,
        dialogId: 'teach-auto-mode',
      }),
    ).toEqual({ dismissed: false });
    expect(t.keys).toEqual([]);
  });

  it('cannot name an unlisted dialog or a permission prompt', () => {
    for (const dialogId of ['trust', 'permission_prompt', 'bypass']) {
      expect(
        parseCommand('session.dismiss', {
          projectId: 'prj_widget',
          subject,
          dialogId,
        }).ok,
      ).toBe(false);
    }
  });
});

describe('card.resume (#447 D10)', () => {
  it('resumes at most twice per round and records each', async () => {
    const t = setup();
    expect(await t.actions.resume(RESUME)).toEqual({
      outcome: 'resumed',
      tmuxSession: 'agentdock-card-ab12cd34',
    });
    await t.actions.resume(RESUME);
    expect(await t.failure(t.actions.resume(RESUME))).toBe('busy');
    expect(t.resumed).toEqual(['run_1', 'run_1']);
    expect(t.acted().map((a) => [a.action, a.result])).toEqual([
      ['resume', 'ok'],
      ['resume', 'ok'],
    ]);
  });

  it('a missing worktree is recorded as a failed resume', async () => {
    const t = setup({ resume: 'no_worktree' });
    expect(await t.actions.resume(RESUME)).toEqual({ outcome: 'no_worktree' });
    expect(t.acted()).toEqual([
      expect.objectContaining({
        action: 'resume',
        result: 'failed',
        detail: 'the worktree is gone',
      }),
    ]);
    expect(t.resumed).toEqual([]);
  });
});
