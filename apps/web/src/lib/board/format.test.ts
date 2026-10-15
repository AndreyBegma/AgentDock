import { describe, expect, test } from 'bun:test';
import type { BoardCardView, TaskDesignStatus } from '@agentdock/shared';
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
  HOOKS_GUIDE_LABEL,
  hooksGuideHref,
  hooksHint,
  parseCardParam,
  parseMaxRunning,
  roundPill,
  toItem,
} from './format';

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

describe('hooksHint (#281 D6)', () => {
  test('names the cause, the key and the exact command', () => {
    expect(hooksHint).toContain('plugin is not set up for its runtime profile');
    expect(hooksHint).toContain('agentdock-runner profiles');
    expect(hooksHint).toContain(
      'agentdock-runner setup claude --profile <key>',
    );
    expect(hooksHint).not.toContain('not installed in this project');
  });

  test('links the Settings › Sessions checklist of the project', () => {
    expect(HOOKS_GUIDE_LABEL).toBe('How to set it up');
    expect(hooksGuideHref('p1')).toBe('/projects/p1/settings?tab=sessions');
  });
});
