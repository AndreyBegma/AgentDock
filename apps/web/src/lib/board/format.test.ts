import { describe, expect, test } from 'bun:test';
import type { BoardCardView, TaskDesignStatus } from '@nautelle/shared';
import type { CardRunWiringReason } from '@nautelle/shared/protocol';
import { ApiError } from '../api';
import { boardView, card, round } from './fixtures';
import {
  approveRunOffer,
  autoRunReason,
  canAccept,
  canGiveFeedback,
  canMarkFinished,
  canRetry,
  canRun,
  canStop,
  cardByNumber,
  columnsOf,
  describeBoardError,
  designBlocksRun,
  finishRefusedText,
  HOOKS_GUIDE_LABEL,
  hooksGuideHref,
  hooksNotice,
  isWorktreeGoneError,
  noPrBanner,
  parseCardParam,
  parseLinkedPlans,
  parseMaxRunning,
  roundPill,
  toItem,
  WORKTREE_GONE_TEXT,
} from './format';

describe('noPrBanner (#395)', () => {
  const RAW =
    'card.collect: not found on the runner — card cmv992gb5007u01octdbcbbg9 has no worktree in cmv6o6qkn01h201o9tlib0our';

  test('a vanished worktree gets a plain sentence, no ids, and no Create button', () => {
    const banner = noPrBanner({ collectState: 'failed', collectError: RAW });
    expect(banner.text).toBe(`No pull request: ${WORKTREE_GONE_TEXT}`);
    expect(banner.text).not.toContain('cmv');
    expect(banner.text).not.toContain('card.collect');
    expect(banner.tone).toBe('warn');
    expect(banner.canCreate).toBe(false);
  });

  test('any other failure keeps its text and the Create button', () => {
    expect(
      noPrBanner({ collectState: 'failed', collectError: 'push rejected' }),
    ).toEqual({
      tone: 'warn',
      text: 'No pull request: push rejected',
      canCreate: true,
    });
    expect(
      noPrBanner({ collectState: 'none', collectError: null }).canCreate,
    ).toBe(true);
  });

  test('only the runner not_found for a missing worktree matches', () => {
    expect(isWorktreeGoneError(RAW)).toBe(true);
    expect(isWorktreeGoneError(null)).toBe(false);
    expect(isWorktreeGoneError('card.collect failed on the runner')).toBe(
      false,
    );
  });
});

describe('roundPill', () => {
  test('none before the first Run and for a finished round', () => {
    expect(roundPill(null)).toBeNull();
    expect(roundPill(round('finished'))).toBeNull();
  });

  test('waiting is the one that asks for the person', () => {
    expect(roundPill(round('waiting'))).toEqual({
      status: 'waiting',
      label: 'Waiting for you',
    });
    expect(roundPill(round('failed'))?.status).toBe('error');
    expect(roundPill(round('cancelled'))?.label).toBe('Stopped');
  });

  test('a refused finish_card of an active round needs attention (#482)', () => {
    expect(
      roundPill({ ...round('waiting'), finishRefused: 'not_a_card_session' }),
    ).toEqual({ status: 'error', label: 'Needs attention' });
    expect(
      roundPill({ ...round('finished'), finishRefused: 'not_a_card_session' }),
    ).toBeNull();
  });

  test('a worker waiting on its own background task is running, not waiting (#390)', () => {
    expect(roundPill(round('background'))).toEqual({
      status: 'running',
      label: 'Running in background',
    });
  });
});

describe('what a card offers', () => {
  test('To Do can run, never be accepted or sent back', () => {
    const c = card(1, 'todo');
    expect(canRun(c)).toBe(true);
    expect(canAccept(c)).toBe(false);
    expect(canGiveFeedback(c)).toBe(false);
  });

  test('a running card can be stopped or marked finished, not run again', () => {
    const c = card(1, 'in_progress', { round: round('running') });
    expect(canStop(c)).toBe(true);
    expect(canMarkFinished(c)).toBe(true);
    expect(canRun(c)).toBe(false);
    expect(canRetry(c)).toBe(false);
  });

  test('a failed round in In progress is a retry', () => {
    const c = card(1, 'in_progress', { round: round('failed') });
    expect(canRetry(c)).toBe(true);
    expect(canStop(c)).toBe(false);
  });

  test('Finished can be accepted, sent back or run again', () => {
    const c = card(1, 'finished', { round: round('finished') });
    expect(canAccept(c)).toBe(true);
    expect(canGiveFeedback(c)).toBe(true);
    expect(canRun(c)).toBe(true);
  });
});

const withDesign = (
  status: TaskDesignStatus,
  needed = true,
): BoardCardView['design'] => ({
  needed,
  suggested: false,
  suggestionWhy: null,
  variantCount: 1,
  status,
  approvedRevisionId: status === 'approved' ? 'rev-1' : null,
  busySince: null,
});

describe('the design gate (#273 D7)', () => {
  const unapproved: TaskDesignStatus[] = [
    'idle',
    'generating',
    'reviewing',
    'revising',
  ];

  test('a needed design in any status but approved blocks Run and Run again', () => {
    for (const status of unapproved) {
      const todo = card(1, 'todo', { design: withDesign(status) });
      const failed = card(2, 'in_progress', {
        design: withDesign(status),
        round: round('failed'),
      });
      expect(designBlocksRun(todo)).toBe(true);
      expect(canRun(todo)).toBe(false);
      expect(canRetry(failed)).toBe(false);
    }
  });

  test('an approved design, a design that is off, or none does not block', () => {
    expect(canRun(card(1, 'todo', { design: withDesign('approved') }))).toBe(
      true,
    );
    expect(canRun(card(1, 'todo', { design: withDesign('idle', false) }))).toBe(
      true,
    );
    expect(canRun(card(1, 'todo'))).toBe(true);
    expect(
      canRetry(
        card(1, 'in_progress', {
          design: withDesign('approved'),
          round: round('failed'),
        }),
      ),
    ).toBe(true);
  });

  test('Approve & run is offered in Run’s place, enabled only in review', () => {
    expect(
      approveRunOffer(card(1, 'todo', { design: withDesign('reviewing') })),
    ).toEqual({ enabled: true, reason: null });
    for (const status of ['idle', 'generating', 'revising'] as const) {
      expect(
        approveRunOffer(card(1, 'todo', { design: withDesign(status) })),
      ).toEqual({ enabled: false, reason: 'The design is being drawn' });
    }
    expect(approveRunOffer(card(1, 'todo'))).toBeNull();
    expect(
      approveRunOffer(card(1, 'todo', { design: withDesign('approved') })),
    ).toBeNull();
  });

  test('no offer where Run would not be there anyway', () => {
    expect(
      approveRunOffer(
        card(1, 'in_progress', {
          design: withDesign('reviewing'),
          round: round('running'),
        }),
      ),
    ).toBeNull();
    expect(
      approveRunOffer(
        card(1, 'completed', { design: withDesign('reviewing') }),
      ),
    ).toBeNull();
  });
});

describe('merge and auto-run copy (#273)', () => {
  const refused = (reason: string, message = 'x') =>
    new ApiError(409, 'merge_failed' as never, message, undefined, {
      error: 'merge_failed',
      reason,
      message,
    });

  test('each merge refusal has its own sentence', () => {
    expect(describeBoardError(refused('head_changed'))).toMatch(
      /branch changed/,
    );
    expect(describeBoardError(refused('not_mergeable'))).toMatch(
      /checks or branch protection/,
    );
    expect(describeBoardError(refused('closed'))).toMatch(/closed/);
    expect(describeBoardError(refused('gh_failed', 'boom'))).toBe(
      'gh failed: boom',
    );
  });

  test('no_pull_request says so', () => {
    const err = new ApiError(409, 'no_pull_request' as never, 'x');
    expect(describeBoardError(err)).toMatch(/no pull request/);
  });

  test('the auto-run failure reads like the same refusal on Run, without the full stop', () => {
    expect(
      autoRunReason({
        code: 'max_running',
        message: 'x',
        at: '2026-10-15T10:00:00.000Z',
      }),
    ).toMatch(/limit of workers[^.]*\.[^.]*$/);
    expect(
      autoRunReason({
        code: 'unknown',
        message: 'Runner exploded.',
        at: '2026-10-15T10:00:00.000Z',
      }),
    ).toBe('Runner exploded');
  });
});

describe('the view', () => {
  test('columnsOf keeps the columns in order, even when one is missing', () => {
    const view = boardView([card(1, 'todo')]);
    view.columns = view.columns.filter((c) => c.column !== 'finished');
    expect(columnsOf(view).map((c) => c.column)).toEqual([
      'inbox',
      'todo',
      'in_progress',
      'finished',
      'completed',
    ]);
  });

  test('columnsOf leaves out the Inbox the API left out for a viewer', () => {
    const view = boardView([card(1, 'todo')]);
    view.columns = view.columns.filter((c) => c.column !== 'inbox');
    expect(columnsOf(view).map((c) => c.column)).toEqual([
      'todo',
      'in_progress',
      'finished',
      'completed',
    ]);
  });

  test('a card reaches the Board with a readable accessible name', () => {
    expect(toItem(card(12, 'todo', { title: 'Dark mode' })).label).toBe(
      'C-12 Dark mode',
    );
  });

  test('cardByNumber finds a card in any column', () => {
    const view = boardView([card(1, 'todo'), card(2, 'completed')]);
    expect(cardByNumber(view, 2)?.id).toBe('card-2');
    expect(cardByNumber(view, 9)).toBeUndefined();
  });
});

describe('describeBoardError for a profile (#272 D7)', () => {
  test('no_profile names Settings › General', () => {
    const err = new ApiError(422, 'no_profile' as never, 'x', undefined, {
      error: 'no_profile',
      reason: 'none',
      source: null,
    });
    expect(describeBoardError(err)).toContain('Settings › General');
  });

  test('no_profile from the orchestrator profile names Settings › Orchestrator', () => {
    const err = new ApiError(422, 'no_profile' as never, 'x', undefined, {
      error: 'no_profile',
      reason: 'not_claude',
      source: 'orchestrator',
      profileKey: 'codex',
    });
    expect(describeBoardError(err)).toContain('Settings › Orchestrator');
  });

  test('unsupported_runtime no longer blames the project’s profile', () => {
    const err = new ApiError(422, 'unsupported_runtime' as never, 'x');
    const text = describeBoardError(err);
    expect(text).not.toMatch(/Codex/);
    expect(text).toMatch(/runner refused/);
  });
});

describe('parsers', () => {
  test('?card= is a positive whole number or nothing', () => {
    expect(parseCardParam('12')).toBe(12);
    expect(parseCardParam('0')).toBeUndefined();
    expect(parseCardParam('-3')).toBeUndefined();
    expect(parseCardParam('1e3')).toBeUndefined();
    expect(parseCardParam(null)).toBeUndefined();
  });

  test('workers at once is 1–10', () => {
    expect(parseMaxRunning('3')).toBe(3);
    expect(parseMaxRunning(' 10 ')).toBe(10);
    expect(parseMaxRunning('0')).toBeNull();
    expect(parseMaxRunning('11')).toBeNull();
    expect(parseMaxRunning('2.5')).toBeNull();
    expect(parseMaxRunning('')).toBeNull();
  });
});

describe('hooksNotice (#281 D6, #367 D3/D4)', () => {
  const manual = { source: 'manual' } as const;

  test('a runner older than #367 is named, and no plugin is asked for', () => {
    const notice = hooksNotice(manual, {
      wiring: 'none',
      wiringReason: 'runner_outdated',
    });
    expect(notice.text).toContain('older than 0.10.0');
    expect(notice.text).not.toContain('plugin');
    expect(notice.text).not.toContain('`');
    expect(notice.commands).toEqual([]);
    expect(notice.guide).toBe(false);
  });

  test('each failed-wiring reason has its own text', () => {
    const text = (wiringReason: CardRunWiringReason) =>
      hooksNotice(manual, { wiring: 'none', wiringReason }).text;
    expect(text('settings_write_failed')).toContain('could not write');
    expect(text('claude_too_old')).toContain('--settings');
    expect(text('settings_write_failed')).not.toBe(text('claude_too_old'));
  });

  test('wired but silent points at the runner connection, not at setup', () => {
    for (const wiring of ['plugin', 'injected'] as const) {
      const notice = hooksNotice(manual, { wiring });
      expect(notice.text).toContain('no hook event reached Nautelle');
      expect(notice.text).not.toContain('not set up');
      expect(notice.commands.map((c) => c.code)).toEqual([
        'nautelle-runner status',
      ]);
      expect(notice.guide).toBe(false);
    }
  });

  test('a terminal or fleet card keeps the setup commands', () => {
    for (const source of ['terminal', 'fleet'] as const) {
      const notice = hooksNotice({ source }, { wiring: null });
      expect(notice.text).toContain('plugin is not set up');
      expect(notice.commands.map((c) => c.code)).toEqual([
        'nautelle-runner profiles',
        'nautelle-runner setup claude --profile <key>',
      ]);
      expect(notice.guide).toBe(true);
    }
  });

  test('a terminal card names the profile it runs in', () => {
    const notice = hooksNotice(
      { source: 'terminal', profileKey: 'claude-work' },
      { wiring: null },
    );
    expect(notice.commands.map((c) => c.code)).toEqual([
      'nautelle-runner setup claude --profile claude-work',
    ]);
    expect(notice.commands[0]?.label).toContain('claude-work');
  });

  test('C-177: the profile key is one shell word in the command', () => {
    for (const round of [
      { wiring: null },
      { wiring: null, hooksCause: 'no_plugin', hooksProfile: "a'b $&;x" },
    ] as const) {
      const notice = hooksNotice(
        { source: 'terminal', profileKey: "a'b $&;x" },
        round,
      );
      expect(notice.commands.map((c) => c.code)).toEqual([
        `nautelle-runner setup claude --profile 'a'\\''b $&;x'`,
      ]);
    }
  });

  test('#348: no_plugin names the profile and its setup command, no placeholder', () => {
    for (const source of ['manual', 'terminal'] as const) {
      const notice = hooksNotice(
        { source },
        { wiring: null, hooksCause: 'no_plugin', hooksProfile: 'claude-work' },
      );
      expect(notice.text).toContain('not set up for the profile claude-work');
      expect(notice.commands.map((c) => c.code)).toEqual([
        'nautelle-runner setup claude --profile claude-work',
      ]);
      expect(notice.commands[0]?.label).toContain('restart its sessions');
      expect(JSON.stringify(notice)).not.toContain('<key>');
      expect(notice.guide).toBe(true);
    }
  });

  test('#348: session_predates says to stop and run again, with no command', () => {
    const notice = hooksNotice(
      { source: 'manual' },
      {
        wiring: 'plugin',
        hooksCause: 'session_predates',
        hooksProfile: 'claude-work',
      },
    );
    expect(notice.text).toContain('set up for claude-work');
    expect(notice.text).toContain('Stop the card and run it again');
    expect(notice.commands).toEqual([]);
    expect(notice.guide).toBe(false);
  });

  test('#348: unknown, or a cause without a profile, keeps today’s text', () => {
    const today = hooksNotice({ source: 'terminal' }, { wiring: null });
    expect(
      hooksNotice(
        { source: 'terminal' },
        { wiring: null, hooksCause: 'unknown', hooksProfile: 'p' },
      ),
    ).toEqual(today);
    expect(
      hooksNotice(
        { source: 'terminal' },
        { wiring: null, hooksCause: 'no_plugin', hooksProfile: null },
      ),
    ).toEqual(today);
  });

  test('#348: the runner’s launch facts outrank the plugin state', () => {
    const notice = hooksNotice(
      { source: 'manual' },
      {
        wiring: 'none',
        wiringReason: 'claude_too_old',
        hooksCause: 'session_predates',
        hooksProfile: 'p',
      },
    );
    expect(notice.text).toContain('--settings');
  });

  test('links the Settings › Sessions checklist of the project', () => {
    expect(HOOKS_GUIDE_LABEL).toBe('See the exact command for each profile');
    expect(hooksGuideHref('p1')).toBe('/projects/p1/settings?tab=sessions');
  });
});

describe('finishRefusedText (#482)', () => {
  test('says why, and what to do, in words', () => {
    const text = finishRefusedText('not_a_card_session');
    expect(text).toContain('the runner may have restarted');
    expect(text).toContain('Ask the worker to call it again');
    expect(text).not.toContain('not_a_card_session');
  });

  test('a code without its own words is spelled out', () => {
    expect(finishRefusedText('internal')).toBe(
      'finish_card was refused: internal. Ask the worker to call it again, or finish the card yourself.',
    );
  });
});

describe('describeBoardError for dependencies (#638, #636)', () => {
  const refused = (error: string, dependencies?: unknown) =>
    new ApiError(409, error as never, 'refused', undefined, {
      error,
      ...(dependencies === undefined ? {} : { dependencies }),
    });
  const ref = (number: number, column: string) => ({
    number,
    label: `C-${number}`,
    column,
  });

  test('dependency_open names what the Run waits for', () => {
    expect(
      describeBoardError(
        refused('dependency_open', [ref(3, 'todo'), ref(5, 'in_progress')]),
      ),
    ).toBe('Waits for C-3 and C-5: no ready pull request to build on yet.');
  });

  test('dependencies_unmerged names the unmerged ones; there is no Run anyway', () => {
    expect(
      describeBoardError(
        refused('dependencies_unmerged', [
          ref(3, 'finished'),
          ref(5, 'finished'),
        ]),
      ),
    ).toBe(
      'C-3 and C-5 are not merged yet; a card branches from one dependency only.',
    );
  });

  test('without a readable list, the shared sentence', () => {
    expect(describeBoardError(refused('dependency_open'))).toBe(
      'A card it depends on has no ready pull request yet.',
    );
  });
});

describe('parseLinkedPlans (C-165)', () => {
  test('a traversal in ?planPanel= opens no panel', () => {
    // `URLSearchParams` decodes it to `../../Q`, the path it would have hit.
    const linked = parseLinkedPlans(
      new URLSearchParams('planPanel=..%2F..%2FQ'),
    );
    expect(linked.planPanelId).toBeUndefined();
  });

  test('only ids pass, for the intake, the panel and the discussion', () => {
    expect(
      parseLinkedPlans(
        new URLSearchParams(
          'intake=cmvb25vkn01i501o68v2unmem&planPanel=c2&discussion=a.b',
        ),
      ),
    ).toEqual({
      intakeId: 'cmvb25vkn01i501o68v2unmem',
      planPanelId: 'c2',
      discussionId: undefined,
    });
    expect(
      parseLinkedPlans(new URLSearchParams('intake=..&planPanel=')),
    ).toEqual({
      intakeId: undefined,
      planPanelId: undefined,
      discussionId: undefined,
    });
  });
});
