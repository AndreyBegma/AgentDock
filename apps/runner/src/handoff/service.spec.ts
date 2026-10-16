import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { HANDOFF_PERSON_MARK } from '@agentdock/shared';
import type {
  UnsequencedEvent,
  WatchedProject,
} from '@agentdock/shared/protocol';
import type { CaptureSpawn } from '../capture/executor';
import type { ConfigProfile } from '../config';
import { isolatedGit } from '../skills/testing';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger, tempDir } from '../testing/fixtures';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { HandoffWriter } from './haiku';
import {
  HANDOFF_REFRESH_TEXT,
  type HandoffCard,
  HandoffService,
} from './service';
import { HANDOFF_NOTE_FILE, HandoffStateStore } from './state';
import { assistantLine, userLine, validNote } from './testing';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  cleanups = [];
});

const OLD_SESSION = '11111111-1111-4111-8111-111111111111';
const CARD_PROMPT =
  'You are the dedicated worker for an AgentDock board card.\n\n## Card C-12: Add login\n\nKind: feature\n';

const resultLine = (result: string) =>
  `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result })}\n`;

const setup = async (
  options: { shipContent?: boolean; haiku?: string } = {},
) => {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const ws = realpathSync(dir);
  const exec = isolatedGit(ws);
  const git = async (...args: string[]) => {
    const result = await exec('git', ['-C', root, ...args]);
    if (!result || result.code !== 0) throw new Error(result?.stderr);
    return result.stdout.trim();
  };
  const root = join(ws, 'app');
  mkdirSync(root, { recursive: true });
  await git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), '# app\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  await git('checkout', '-q', '-b', 'card/c12-add-login');
  writeFileSync(join(root, '.git', 'info', 'exclude'), '.agentdock/\n');

  const clock = new FakeClock(Date.parse('2026-10-16T12:00:00.000Z'));
  const configDir = join(ws, 'claude');
  const profile: ConfigProfile = {
    id: 'claude',
    runtime: 'claude',
    env: { CLAUDE_CONFIG_DIR: configDir },
    args: [],
  };
  const project: WatchedProject = {
    id: 'p1',
    root,
    shipContent: options.shipContent === true,
  };
  const card: HandoffCard = {
    cardId: 'cmcard01',
    projectId: 'p1',
    repo: 'acme/app',
    root,
    shortId: 'ab12cd34',
    worktree: root,
    base: 'main',
    runId: 'run_2',
    phase: 'running',
    sessionId: OLD_SESSION,
    profileKey: 'claude',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    tmuxSession: 'agentdock-card-ab12cd34',
  };
  const cardsDir = join(ws, 'cards');
  const state = new HandoffStateStore((id) => join(cardsDir, id));
  const events: UnsequencedEvent[] = [];
  const typed: string[] = [];
  const haikuPrompts: string[] = [];
  const spawn: CaptureSpawn = ({ stdinFile }) => {
    haikuPrompts.push(readFileSync(stdinFile, 'utf8'));
    return {
      exited: Promise.resolve(0),
      stdout: Promise.resolve(resultLine(options.haiku ?? '')),
      stderr: Promise.resolve(''),
      kill: () => {},
    };
  };
  const service = new HandoffService({
    deps: {
      exec,
      clock,
      home: ws,
      profiles: () => [profile],
      watchedProjects: () => [project],
    },
    state,
    record: (id) => (id === card.cardId ? card : null),
    records: () => [card],
    typeAtPrompt: async (_session, text) => {
      typed.push(text);
      return true;
    },
    writer: new HandoffWriter({
      dir: join(ws, 'handoff'),
      env: {},
      clock,
      log: memoryLogger().log,
      spawn,
    }),
    emit: (event) => events.push(event),
    log: memoryLogger().log,
  });
  const notePath = join(root, HANDOFF_NOTE_FILE);
  const writeNote = (text: string, ageMs = 0) => {
    mkdirSync(join(root, '.agentdock'), { recursive: true });
    writeFileSync(notePath, text);
    if (ageMs > 0) {
      const at = new Date(Date.now() - ageMs);
      utimesSync(notePath, at, at);
    }
  };
  const transcript = (lines: string[], session = OLD_SESSION) => {
    const dirPath = join(configDir, 'projects', '-app');
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, `${session}.jsonl`), `${lines.join('\n')}\n`);
  };
  const commit = async (file: string) => {
    writeFileSync(join(root, file), `${file}\n`);
    await git('add', file);
    await git('commit', '-q', '-m', `add ${file}`);
  };
  const ofType = (type: string) => events.filter((e) => e.type === type);
  const stop = async () => {
    service.hookSeen({
      type: 'hook.stopped',
      session: { runtime: 'claude', id: card.sessionId ?? '' },
      data: {},
    });
    await service.settled();
  };
  const hook = async (type: string, data: Record<string, unknown>) => {
    service.hookSeen({
      type,
      session: { runtime: 'claude', id: card.sessionId ?? '' },
      data,
    });
    await service.settled();
  };
  const preCompact = () => hook('hook.pre_compact', { trigger: 'auto' });
  const compacted = () =>
    hook('hook.session_started', {
      source: 'compact',
      cwd: root,
      permissionMode: 'default',
    });
  const round1 = () =>
    service.prepareRound(
      { ...card, runId: 'run_1' },
      {
        session: { id: OLD_SESSION, resume: false },
        prompt: CARD_PROMPT,
        profileKey: 'claude',
      },
      profile,
    );
  const nextRound = () =>
    service.prepareRound(
      card,
      {
        session: { id: OLD_SESSION, resume: true },
        prompt: 'Review feedback: rename the button.',
        profileKey: 'claude',
      },
      profile,
    );
  /** The current round, launched with Context handoff on (no transcript: resume). */
  const prepareActive = () => nextRound();
  return {
    root,
    card,
    prepareActive,
    clock,
    profile,
    service,
    state,
    events,
    typed,
    haikuPrompts,
    notePath,
    writeNote,
    transcript,
    commit,
    ofType,
    stop,
    preCompact,
    compacted,
    round1,
    nextRound,
  };
};

describe('HandoffService — the restart decision (#449 D3)', () => {
  it('round 1 is `first`: its prompt and the card number are kept', async () => {
    const t = await setup();
    const prepared = await t.round1();
    expect(prepared.restart).toEqual({ mode: 'first' });
    expect(prepared.launch.session).toEqual({ id: OLD_SESSION, resume: false });
    expect(t.state.cardPrompt(t.card.cardId)).toBe(CARD_PROMPT);
    expect(t.state.load(t.card.cardId).number).toBe(12);
    t.service.reportRestart({ ...t.card, runId: 'run_1' }, prepared);
    expect(t.ofType('round.restart').map((e) => e.data)).toEqual([
      expect.objectContaining({
        mode: 'first',
        estimate: null,
        sessionId: OLD_SESSION,
        runId: 'run_1',
      }),
    ]);
  });

  it('resumes with a warm cache and a short history, recording both estimates', async () => {
    const t = await setup();
    await t.round1();
    t.writeNote(validNote());
    t.transcript([
      assistantLine({
        at: new Date(t.clock.now() - 60_000).toISOString(),
        id: 'm1',
        input: 10,
        cacheRead: 1_500,
      }),
    ]);
    const prepared = await t.nextRound();
    expect(prepared.launch).toEqual({
      session: { id: OLD_SESSION, resume: true },
      prompt: 'Review feedback: rename the button.',
    });
    expect(prepared.restart).toMatchObject({
      mode: 'resume',
      estimate: { resumeTokens: 1_510, cacheWarm: true },
    });
    if (prepared.restart.mode === 'resume') {
      expect(prepared.restart.estimate.freshTokens).toBeGreaterThan(0);
    }
  });

  it('starts fresh with a cold cache and a long history, seeded with the note, diff and checklist', async () => {
    const t = await setup();
    await t.round1();
    await t.commit('login.ts');
    t.writeNote(validNote('Ship the login page.', '1. Rename the button.'));
    mkdirSync(join(t.root, '.agentdock'), { recursive: true });
    writeFileSync(
      join(t.root, '.agentdock', 'pull-request.md'),
      '## What changed and why\n\nx\n\n## Acceptance criteria\n\n- [x] the form submits\n- [ ] the button is renamed\n',
    );
    t.transcript([
      assistantLine({
        at: new Date(t.clock.now() - 3 * 60 * 60_000).toISOString(),
        id: 'm1',
        input: 10,
        cacheRead: 180_000,
      }),
    ]);
    const prepared = await t.nextRound();
    expect(prepared.restart).toMatchObject({
      mode: 'fresh',
      estimate: { resumeTokens: 180_010, cacheWarm: false },
      previousSessionId: OLD_SESSION,
    });
    const { session, prompt } = prepared.launch;
    expect(session.resume).toBe(false);
    expect(session.id).not.toBe(OLD_SESSION);
    expect(prompt.startsWith(CARD_PROMPT.trimEnd())).toBe(true);
    expect(prompt).toContain('1. Rename the button.');
    expect(prompt).toContain('login.ts');
    expect(prompt).toContain('- [ ] the button is renamed');
    expect(
      prompt.trimEnd().endsWith('Review feedback: rename the button.'),
    ).toBe(true);
    // The old session is never discarded.
    expect(t.state.load(t.card.cardId).sessions).toEqual([
      OLD_SESSION,
      session.id,
    ]);
    t.service.reportRestart(t.card, prepared);
    expect(t.ofType('round.restart')[0]?.data).toMatchObject({
      mode: 'fresh',
      sessionId: session.id,
      previousSessionId: OLD_SESSION,
    });
  });

  it('resumes when there is no note, or no round-1 prompt, however cold', async () => {
    const t = await setup();
    t.transcript([
      assistantLine({
        at: '2026-10-15T00:00:00.000Z',
        id: 'm1',
        cacheRead: 500_000,
      }),
    ]);
    t.writeNote(validNote());
    expect((await t.nextRound()).restart.mode).toBe('resume');
    await t.round1();
    t.writeNote('## Goal\nincomplete\n');
    expect((await t.nextRound()).restart.mode).toBe('resume');
  });
});

describe('HandoffService — the note (#449 D2, D5, D7, D8)', () => {
  it('asks exactly once per round to refresh a note older than a commit', async () => {
    const t = await setup();
    await t.prepareActive();
    t.writeNote(validNote(), 10 * 60_000);
    await t.commit('form.ts');
    await t.stop();
    await t.stop();
    expect(t.typed).toEqual([HANDOFF_REFRESH_TEXT]);
  });

  it('#494: before a compaction a stale note gets exactly one request, owed to the start after it', async () => {
    const t = await setup();
    await t.prepareActive();
    t.writeNote(validNote(), 10 * 60_000);
    await t.commit('form.ts');
    await t.preCompact();
    // Nothing is typed at a prompt that is busy compacting.
    expect(t.typed).toEqual([]);
    expect(t.state.load(t.card.cardId)).toMatchObject({
      asked: ['run_2'],
      compactAsk: 'run_2',
    });
    // The SessionStart after the compaction carried it (the hook prints it).
    await t.compacted();
    expect(t.state.load(t.card.cardId).compactAsk).toBeUndefined();
    // A second compaction and the stop of the same round ask no more.
    await t.preCompact();
    await t.stop();
    expect(t.typed).toEqual([]);
    expect(t.state.load(t.card.cardId)).toMatchObject({ asked: ['run_2'] });
    expect(t.state.load(t.card.cardId).compactAsk).toBeUndefined();
  });

  it('#494: a fresh note, or a round asked at a stop, owes nothing at a compaction', async () => {
    const t = await setup();
    await t.prepareActive();
    await t.commit('form.ts');
    t.writeNote(validNote());
    await t.preCompact();
    expect(t.state.load(t.card.cardId).compactAsk).toBeUndefined();

    t.writeNote(validNote(), 10 * 60_000);
    await t.stop();
    expect(t.typed).toEqual([HANDOFF_REFRESH_TEXT]);
    await t.preCompact();
    expect(t.state.load(t.card.cardId).compactAsk).toBeUndefined();
  });

  it('does not ask a round that made no commit, or whose note is newer', async () => {
    const t = await setup();
    await t.prepareActive();
    t.writeNote(validNote());
    await t.stop();
    expect(t.typed).toEqual([]);
  });

  it('refuses an invalid note once with the reason, then takes the rewrite', async () => {
    const t = await setup({ shipContent: true });
    await t.prepareActive();
    t.writeNote(validNote().replace('## Dead ends\n', ''));
    await t.stop();
    await t.stop();
    expect(t.typed).toHaveLength(1);
    expect(t.typed[0]).toContain('"## Dead ends" is missing');
    t.writeNote(validNote('Ship it now.'));
    await t.stop();
    const updates = t.ofType('handoff.updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.data).toMatchObject({
      subject: { kind: 'card', cardId: t.card.cardId },
      updatedBy: 'agent',
      content: validNote('Ship it now.'),
    });
    expect(updates[0]?.project).toEqual({ repo: 'acme/app', root: t.root });
  });

  it('sends no note content when the project ships none (ADR-0021)', async () => {
    const t = await setup({ shipContent: false });
    await t.prepareActive();
    t.writeNote(validNote('Secret plan.'));
    await t.stop();
    expect(t.state.load(t.card.cardId).note?.content).toBe(
      validNote('Secret plan.'),
    );
    expect(t.ofType('handoff.updated')).toEqual([]);
    expect(JSON.stringify(t.events)).not.toContain('Secret plan');
  });

  it('applies a person edit with marks, and holds the agent to those lines', async () => {
    const t = await setup({ shipContent: true });
    await t.prepareActive();
    const edited = validNote('Ship it.', 'Ask before renaming.');
    expect(
      await t.service.setFromPerson({
        projectId: 'p1',
        cardId: t.card.cardId,
        shortId: t.card.shortId,
        content: edited,
        personLines: [{ from: 7, to: 7 }],
      }),
    ).toEqual({ outcome: 'applied' });
    expect(readFileSync(t.notePath, 'utf8')).toContain(
      `Ask before renaming.${HANDOFF_PERSON_MARK}`,
    );
    expect(t.ofType('handoff.updated')[0]?.data).toMatchObject({
      updatedBy: 'person',
      personLines: [{ from: 7, to: 7 }],
    });

    // The agent drops the person's line: refused, naming it.
    t.writeNote(validNote('Ship it.', '1. Rename freely.'));
    await t.stop();
    expect(t.typed.at(-1)).toContain('- Ask before renaming.');

    // The agent keeps it (and forges a mark of its own): only the person's counts.
    t.writeNote(
      validNote(
        'Ship it.',
        `1. Add the form.${HANDOFF_PERSON_MARK}\nAsk before renaming.${HANDOFF_PERSON_MARK}`,
      ),
    );
    await t.stop();
    const stored = t.state.load(t.card.cardId).note;
    expect(stored?.updatedBy).toBe('agent');
    expect(stored?.personLines).toEqual([{ from: 8, to: 8 }]);
    expect(readFileSync(t.notePath, 'utf8')).toContain(
      `1. Add the form.\nAsk before renaming.${HANDOFF_PERSON_MARK}`,
    );
  });

  it('a person edit for a card without a worktree here is no_worktree', async () => {
    const t = await setup();
    expect(
      await t.service.setFromPerson({
        projectId: 'p1',
        cardId: t.card.cardId,
        shortId: 'zz99zz99',
        content: validNote(),
        personLines: [],
      }),
    ).toEqual({ outcome: 'no_worktree' });
  });

  it('a dead session with a stale note gets one from haiku, from its transcript', async () => {
    const haiku = validNote('Ship the login page.', '1. Wire the submit.');
    const t = await setup({ haiku: `\`\`\`markdown\n${haiku}\n\`\`\`` });
    await t.prepareActive();
    await t.commit('form.ts');
    t.transcript([
      userLine('2026-10-16T11:59:00.000Z', 'Build the login form.'),
      assistantLine({
        at: '2026-10-16T11:59:30.000Z',
        id: 'm1',
        text: 'The form posts to /session.',
      }),
    ]);
    await t.service.sessionEnded(t.card);
    expect(t.haikuPrompts).toHaveLength(1);
    expect(t.haikuPrompts[0]).toContain('The form posts to /session.');
    expect(readFileSync(t.notePath, 'utf8').trim()).toBe(haiku.trim());
    expect(t.state.load(t.card.cardId).note?.updatedBy).toBe('haiku');
  });

  it('haiku leaves the note alone when what it writes is not valid', async () => {
    const t = await setup({ haiku: 'I could not write a note.' });
    await t.prepareActive();
    await t.commit('form.ts');
    t.transcript([userLine('2026-10-16T11:59:00.000Z', 'Build it.')]);
    await t.service.sessionEnded(t.card);
    expect(t.haikuPrompts).toHaveLength(1);
    expect(existsSync(t.notePath)).toBe(false);
  });

  it('does nothing for a round launched without Context handoff', async () => {
    const t = await setup();
    t.writeNote(validNote(), 10 * 60_000);
    await t.commit('form.ts');
    await t.stop();
    await t.service.sessionEnded(t.card);
    expect(t.typed).toEqual([]);
    expect(t.haikuPrompts).toEqual([]);
  });
});

describe('HandoffService — the warm-up (#449 D9)', () => {
  it('reports tokens and ms to the first file edit, once', async () => {
    const t = await setup();
    await t.prepareActive();
    const start = t.clock.now();
    t.clock.advance(42_000);
    t.transcript([
      assistantLine({
        at: new Date(start - 1_000).toISOString(),
        id: 'before',
        input: 99_999,
      }),
      assistantLine({
        at: new Date(start + 1_000).toISOString(),
        id: 'm1',
        input: 100,
        cacheRead: 900,
        tools: ['Read'],
      }),
      assistantLine({
        at: new Date(start + 40_000).toISOString(),
        id: 'm2',
        input: 50,
        cacheRead: 1_950,
        tools: ['Edit'],
      }),
    ]);
    const edit = {
      type: 'hook.tool_finished',
      session: { runtime: 'claude' as const, id: OLD_SESSION },
      data: { toolName: 'Edit' },
    };
    t.service.hookSeen(edit);
    t.service.hookSeen(edit);
    await t.service.settled();
    expect(t.ofType('round.warmup').map((e) => e.data)).toEqual([
      expect.objectContaining({
        cardId: t.card.cardId,
        runId: 'run_2',
        tokens: 3_000,
        ms: 42_000,
      }),
    ]);
  });
});
