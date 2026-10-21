import { describe, expect, test } from 'bun:test';
import type {
  BoardCardView,
  BoardColumn,
  BoardPlanTaskView,
} from '@nautelle/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { card as fixtureCard, round } from '../../lib/board/fixtures';
import { CardFace } from './card-face';
import { PlanTaskFace } from './plan-task-face';
import { TAP } from './tap';

const COLUMNS: BoardColumn[] = ['todo', 'in_progress', 'finished', 'completed'];

/** Stands in for the Board's `slots.menu`. */
const MENU = <button type="button" data-menu-trigger aria-label="Actions" />;

const render = (
  column: BoardColumn,
  extra: Partial<BoardCardView> = {},
  options: { menu?: boolean } = {},
) =>
  renderToStaticMarkup(
    <CardFace
      projectId="p1"
      canOperate
      menu={options.menu === false ? undefined : MENU}
      onOpen={() => undefined}
      card={fixtureCard(7, column, {
        prNumber: 7,
        prUrl: 'https://github.com/o/r/pull/7',
        prState: 'open',
        ...extra,
      })}
    />,
  );

/** The markup of one `data-card-row`, up to the next row or the end. */
const row = (html: string, name: 'header' | 'saved' | 'status' | 'footer') => {
  const start = html.indexOf(`data-card-row="${name}"`);
  if (start < 0) return null;
  const next = html.indexOf('data-card-row="', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
};

const design = (status: 'reviewing' | 'approved'): BoardCardView['design'] => ({
  needed: true,
  suggested: false,
  suggestionWhy: null,
  variantCount: 1,
  status,
  approvedRevisionId: status === 'approved' ? 'rev-1' : null,
  busySince: null,
});

describe('CardFace pull request link (#329 D6)', () => {
  for (const column of COLUMNS) {
    test(`shows PR #7 with its state in ${column}`, () => {
      const html = render(column);
      expect(html).toContain('PR #7 · Open');
      expect(html).toContain('href="https://github.com/o/r/pull/7"');
    });
  }

  test('shows the merged state, and a bare number while the state is unknown', () => {
    expect(render('completed', { prState: 'merged' })).toContain(
      'PR #7 · Merged',
    );
    const unknown = render('in_progress', { prState: null });
    expect(unknown).toContain('PR #7<');
    expect(unknown).not.toContain('·');
  });

  test('a card without a PR shows the issue link only', () => {
    const html = render('finished', {
      prNumber: null,
      prUrl: null,
      prState: null,
      issueNumber: 3,
      issueUrl: 'https://github.com/o/r/issues/3',
    });
    expect(html).not.toContain('PR #');
    expect(html).toContain('Issue #3');
  });
});

describe('CardFace shipping state (#359)', () => {
  test('red CI shows the dot and Fixing CI (n/3)', () => {
    const html = render('in_progress', { ciState: 'red', ciFixAttempts: 2 });
    expect(html).toContain('aria-label="Checks failed"');
    expect(html).toContain('Fixing CI (2/3)');
  });

  test('a merged card in Finished is badged Merged', () => {
    const html = render('finished', { mergedAt: '2026-10-16T10:00:00.000Z' });
    expect(html).toContain('Merged');
  });

  test('no checks, no dot', () => {
    expect(render('in_progress')).not.toContain('Checks');
  });

  test('a failed collect is badged Not pushed in the status row (#630)', () => {
    const html = render('finished', {
      collectState: 'failed',
      collectError: 'card.collect failed on the runner',
    });
    expect(row(html, 'status')).toContain('Not pushed');
    expect(render('finished')).not.toContain('Not pushed');
  });

  test('a diverged branch needs a person and says why, once (#630)', () => {
    const html = render('finished', {
      collectState: 'failed',
      collectError:
        'origin/x (ab12cd34) has commits the card’s branch never had',
      needsPerson: true,
      needsPersonReason: 'branch_diverged',
    });
    expect(row(html, 'status')).toContain(
      'Branch diverged on origin; not pushed',
    );
    expect(html).not.toContain('Not pushed');
  });
});

describe('CardFace rows (C-35, #423)', () => {
  const busy = {
    kind: 'bug' as const,
    attachmentCount: 2,
    dependsOn: [{ number: 3, label: 'C-3', column: 'todo' as const }],
    costUsd: '4.81',
  };

  test('the header holds label, Bug, attachments, dependency, then the cost and the menu at its end', () => {
    const header = row(render('todo', busy), 'header') ?? '';
    const order = [
      'C-7',
      'Bug',
      '2 attachments',
      'after C-3',
      '$4.81',
      'data-menu-trigger',
    ].map((text) => header.indexOf(text));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test('the menu is placed once, in the header, and nowhere else', () => {
    const html = render('todo', busy);
    expect(html.split('data-menu-trigger').length).toBe(2);
    expect(row(html, 'status') ?? '').not.toContain('data-menu-trigger');
  });

  test('without a menu or a cost the header has no end group', () => {
    const header = row(render('todo', {}, { menu: false }), 'header') ?? '';
    expect(header).not.toContain('ms-auto');
  });

  test('the footer carries PR and Issue above a hairline', () => {
    const extra = {
      issueNumber: 3,
      issueUrl: 'https://github.com/o/r/issues/3',
    };
    const footer = row(render('in_progress', extra), 'footer') ?? '';
    expect(footer).toContain('border-t');
    expect(footer).toContain('PR #7 · Open');
    expect(footer).toContain('Issue #3');
    expect(render('in_progress')).not.toContain('Issue #3');
  });

  test('round, design, hooks, auto-run failure and shipping share the status row', () => {
    const status =
      row(
        render('in_progress', {
          design: design('approved'),
          round: round('running', { hooksMissing: true }),
          autoRunFailure: {
            code: 'unknown',
            message: 'boom',
            at: '2026-10-16T10:00:00.000Z',
          },
          ciState: 'red',
          ciFixAttempts: 1,
        }),
        'status',
      ) ?? '';
    expect(status).toContain('Design approved');
    expect(status).toContain('Running');
    expect(status).toContain('Didn’t start');
    expect(status).toContain('Fixing CI (1/3)');
  });

  test('the approve offer sits under the status row, not in the header', () => {
    const html = render('todo', { design: design('reviewing') });
    expect(row(html, 'status') ?? '').toContain('Design in review');
    expect(html).toContain('Approve &amp; run');
    expect(row(html, 'header') ?? '').not.toContain('Approve');
  });

  test('a terminal card puts its badges in the status row and its Session link below', () => {
    const html = render('in_progress', {
      source: 'terminal',
      tracking: { sessionId: 's-1', alive: true },
      autoCollect: true,
    });
    const status = row(html, 'status') ?? '';
    expect(status).toContain('Terminal');
    expect(status).toContain('Session running');
    expect(status).toContain('Automatic work');
    expect(html).toContain('>Session<');
  });

  test('a fleet card shows its badges, its slot line and the Fleet link', () => {
    const html = render('in_progress', {
      source: 'fleet',
      fleet: { issue: 12, slot: 'i12-web', stage: 'pr_open', slotGone: true },
    });
    const status = row(html, 'status') ?? '';
    expect(status).toContain('Fleet');
    expect(status).toContain('Slot gone');
    expect(html).toContain('i12-web · PR open');
    expect(html).toContain('Open in Fleet');
  });

  test('a suggestion shows Suggested, its confidence, the why and the source session', () => {
    const html = render('inbox', {
      prNumber: null,
      prUrl: null,
      prState: null,
      captureWhy: 'The session hit three 429s.',
      captureConfidence: 0.82,
      sourceSessionId: 'sess-1',
    });
    const status = row(html, 'status') ?? '';
    expect(status).toContain('Suggested');
    expect(status).toContain('82% sure');
    expect(html).toContain('The session hit three 429s.');
    expect(html).toContain('Source session');
  });
});

describe('PlanTaskFace with the inline menu (C-35)', () => {
  const task: BoardPlanTaskView = {
    planId: 'plan-1',
    planTitle: 'Onboarding v2',
    taskId: 'task-t1',
    key: 't1',
    title: 'Task t1',
    kind: 'feature',
    column: 'todo',
    status: 'draft',
    issue: null,
    design: null,
    summary: '',
    updatedAt: '2026-10-14T10:00:00.000Z',
  };

  test('places the menu in its header row, before the title', () => {
    const html = renderToStaticMarkup(
      <PlanTaskFace task={task} menu={MENU} onOpen={() => undefined} />,
    );
    expect(html).toContain('data-menu-trigger');
    expect(html.indexOf('data-menu-trigger')).toBeLessThan(
      html.indexOf('Task t1'),
    );
  });
});

describe('CardFace readiness and Auto-run (#443)', () => {
  const dep = (number: number, column: BoardColumn) => ({
    number,
    label: `C-${number}`,
    column,
  });

  test('a ready card shows Ready', () => {
    const status = row(
      render('todo', {
        readiness: { state: 'ready', satisfied: 2, total: 2, open: [] },
      }),
      'status',
    );
    expect(status).toContain('Ready');
    expect(status).not.toContain('Waiting');
  });

  test('a waiting card shows Waiting and what it waits for', () => {
    const status = row(
      render('todo', {
        readiness: {
          state: 'waiting',
          satisfied: 1,
          total: 2,
          open: [dep(84, 'in_progress')],
        },
      }),
      'status',
    );
    expect(status).toContain('Waiting · 1 of 2');
    expect(status).toContain('Waits for C-84');
  });

  test('the dependency chip reads a Finished dependency as satisfied (#638)', () => {
    const header = (column: BoardColumn) =>
      row(render('todo', { dependsOn: [dep(3, column)] }), 'header') ?? '';
    expect(header('finished')).toContain('Runs after C-3, all ready.');
    expect(header('in_progress')).toContain('No ready pull request yet: C-3.');
  });

  test('the Auto-run marker shows only with the switch on', () => {
    expect(row(render('todo', { autoRunWhenReady: true }), 'status')).toContain(
      'Auto-run',
    );
    expect(render('todo')).not.toContain('Auto-run');
  });

  test('a refused auto-run says it did not start', () => {
    const html = render('todo', {
      autoRunFailure: {
        code: 'max_running',
        message: '1 of 1 card workers are running in this project',
        at: '2026-10-16T10:00:00.000Z',
        after: 84,
      },
    });
    expect(row(html, 'status')).toContain('Didn’t start');
  });
});

describe('CardFace touch targets (#497)', () => {
  test('the title and the footer links are touch targets', () => {
    const html = render('in_progress', {
      issueNumber: 3,
      issueUrl: 'https://github.com/o/r/issues/3',
    });
    expect(html.split(TAP).length - 1).toBe(3);
    expect(row(html, 'footer')?.split(TAP).length).toBe(3);
  });

  test('the header grows to the touch target only when it holds the menu', () => {
    const coarse = 'pointer-coarse:h-(--size-tap)';
    expect(row(render('todo'), 'header')).toContain(coarse);
    expect(row(render('todo', {}, { menu: false }), 'header')).not.toContain(
      coarse,
    );
  });
});

describe('CardFace token-saver badge on a narrow card (#738)', () => {
  const tokenSaved = { estimateUsd: 0.004, estimateTokens: 1_000 };

  test('the header badge gives way below 15rem and the right group still holds cost and menu', () => {
    const html = render('completed', { costUsd: '0.3', tokenSaved });
    const header = row(html, 'header') ?? '';
    expect(header).toContain('@max-[15rem]:hidden');
    expect(header).toContain('data-menu-trigger');
    expect(header).toContain('$0.30');
  });

  test('the same badge shows on its own truncating line, title intact', () => {
    const html = render('completed', { costUsd: '0.3', tokenSaved });
    const saved = row(html, 'saved') ?? '';
    expect(html).toContain('@container');
    expect(saved).toContain('@max-[15rem]:flex');
    expect(saved).toContain('min-w-0 truncate');
    expect(saved).toContain('title="Token saver kept');
  });

  test('a card that saved nothing has no saved line', () => {
    expect(row(render('completed'), 'saved')).toBeNull();
  });
});

describe('the selection slot (#596)', () => {
  const selected = (
    column: BoardColumn,
    extra: Partial<BoardCardView>,
    selecting: boolean,
  ) =>
    renderToStaticMarkup(
      <CardFace
        projectId="p1"
        canOperate
        menu={MENU}
        onOpen={() => undefined}
        selection={{ selected: false, selecting, onToggle: () => undefined }}
        card={fixtureCard(7, column, extra)}
      />,
    );

  test('the box sits in the header row, inside the card, not over its border', () => {
    const html = selected('todo', {}, false);
    const header = row(html, 'header') ?? '';
    expect(header).toContain('data-selection-box');
    expect(header.indexOf('data-selection-box')).toBeLessThan(
      header.indexOf('C-7'),
    );
    expect(html).not.toMatch(/-start-\[|-top-\[/);
  });

  test('a suggestion keeps the same slot, empty until something is selected', () => {
    const idle = row(selected('inbox', {}, false), 'header');
    const busy = row(selected('inbox', {}, true), 'header');
    expect(idle).toContain('invisible');
    expect(busy).not.toContain('invisible');
    expect(busy).toContain('<svg');
  });

  test('a plan task reserves the slot in its header', () => {
    const task: BoardPlanTaskView = {
      planId: 'plan-1',
      planTitle: 'Onboarding v2',
      taskId: 'task-t1',
      key: 't1',
      title: 'Task t1',
      kind: 'feature',
      column: 'todo',
      status: 'draft',
      issue: null,
      design: null,
      summary: '',
      updatedAt: '2026-10-14T10:00:00.000Z',
    };
    const html = renderToStaticMarkup(
      <PlanTaskFace task={task} selecting onOpen={() => undefined} />,
    );
    expect(html).toContain('size-4');
    expect(html).not.toContain('invisible');
  });
});
