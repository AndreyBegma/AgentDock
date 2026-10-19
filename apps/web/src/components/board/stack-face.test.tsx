import { describe, expect, test } from 'bun:test';
import {
  type BoardColumn,
  type BoardStackView,
  STACK_GATE_REASON,
} from '@agentdock/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { boardView, card } from '../../lib/board/fixtures';
import { boardItems } from '../../lib/board/plan-tasks';
import { foldStacks, isStackItem } from '../../lib/board/stacks';
import { CardFace } from './card-face';
import { StackFace } from './stack-face';
import { TAP, TAP_ROW } from './tap';
import type { CardActions } from './use-card-actions';

const ref = (stage: number) => ({
  number: 3,
  label: 'S-3',
  title: 'Redesign the Settings page',
  stage,
  stageTitle: stage === 0 ? 'Components' : 'Page',
  gate: STACK_GATE_REASON,
});

const stack: BoardStackView = {
  run: null,
  id: 'stack-3',
  number: 3,
  label: 'S-3',
  title: 'Redesign the Settings page',
  column: 'todo',
  accepted: 1,
  total: 3,
  currentStage: 0,
  stages: [
    { position: 0, title: 'Components', cards: [1, 2] },
    { position: 1, title: 'Page', cards: [4] },
  ],
  design: {
    needed: true,
    suggested: true,
    suggestionWhy: null,
    variantCount: 1,
    status: 'reviewing',
    approvedRevisionId: null,
    busySince: null,
  },
  costUsd: '3.84',
};

const cards = [
  card(1, 'completed', { stack: ref(0), title: 'Settings form section' }),
  card(2, 'todo', { stack: ref(0), title: 'Danger zone panel' }),
  card(4, 'todo', { stack: ref(1), title: 'Compose the Settings page' }),
];
const view = { ...boardView(cards), stacks: [stack] };
const [face] = foldStacks(
  boardItems(view, []).get('todo') ?? [],
  'todo',
  view,
  false,
);

const actions = {
  busy: false,
  run: async () => true,
} as unknown as CardActions;

const render = (defaultOpen: boolean, over: Partial<BoardStackView> = {}) => {
  if (!isStackItem(face)) throw new Error('no stack face');
  return renderToStaticMarkup(
    <StackFace
      projectId="p1"
      item={{ ...face, stack: { ...face.stack, ...over } }}
      canOperate
      actions={actions}
      defaultOpen={defaultOpen}
      onOpenCard={() => undefined}
    />,
  );
};

describe('StackFace (#480)', () => {
  test('collapsed: title, progress, current stage and the design chip — no cards', () => {
    const html = render(false);
    expect(html).toContain('S-3');
    expect(html).toContain('Stack · 3 cards');
    expect(html).toContain('Redesign the Settings page');
    expect(html).toContain('1 of 3 accepted');
    expect(html).toContain('Stage 1 of 2 · Components');
    expect(html).toContain('Stack design not approved');
    expect(html).toContain('Expand');
    expect(html).toContain('href="/projects/p1/board/stacks/3"');
    expect(html).not.toContain('Danger zone panel');
  });

  test('expanded: its cards by stage, each with its own column, Run disabled with the reason', () => {
    const html = render(true);
    expect(html).toContain('Collapse');
    expect(html).toContain('after all of Stage 1');
    expect(html).toContain('Danger zone panel');
    expect(html).toContain('Compose the Settings page');
    expect(html).toContain('Completed');
    expect(html).toContain('To Do');
    expect(html).toContain(`Run C-2: ${STACK_GATE_REASON}`);
  });

  test('#652: shows the stack run — running, paused — and nothing before a run', () => {
    expect(render(false)).not.toContain('data-status="paused"');
    const running = render(false, {
      run: {
        state: 'running',
        pause: null,
        queued: 1,
        waiting: 0,
        running: 2,
        startedAt: '2026-10-19T12:00:00.000Z',
      },
    });
    expect(running).toContain('2 running');
    const paused = render(false, {
      run: {
        state: 'paused',
        pause: {
          code: 'round_failed',
          message: 'The round of C-2 failed',
          card: 2,
          at: '2026-10-19T12:00:00.000Z',
        },
        queued: 1,
        waiting: 0,
        running: 0,
        startedAt: '2026-10-19T12:00:00.000Z',
      },
    });
    expect(paused).toContain('Run paused');
  });

  test('a card of a stack wears the stack label on its own face', () => {
    const html = renderToStaticMarkup(
      <CardFace
        projectId="p1"
        canOperate
        onOpen={() => undefined}
        card={card(2, 'in_progress', { stack: ref(0) })}
      />,
    );
    expect(html).toContain('S-3');
    expect(html).toContain('part of Redesign the Settings page');
  });

  test('#497: the title, the stack-card titles and their control rows are touch targets', () => {
    const html = render(true);
    // The stack title link and the title buttons of its three cards.
    expect(html.split(TAP).length - 1).toBe(4);
    // Expand / Open stack, and the Run row of each runnable stack card.
    expect(html).toContain(TAP_ROW);
  });
});

describe('StackFace Run held by dependencies (#638)', () => {
  const dep = (number: number, column: BoardColumn) => ({
    number,
    label: `C-${number}`,
    column,
  });
  const approved = (stage: number) => ({ ...ref(stage), gate: null });

  const renderWith = (stageTwoDeps: ReturnType<typeof dep>[]) => {
    const held = [
      card(1, 'completed', { stack: approved(0) }),
      card(2, 'todo', { stack: approved(0) }),
      card(4, 'todo', {
        stack: approved(1),
        title: 'Compose the Settings page',
        dependsOn: stageTwoDeps,
      }),
    ];
    const heldView = {
      ...boardView(held),
      stacks: [{ ...stack, design: { ...stack.design, status: 'approved' } }],
    } as typeof view;
    const [item] = foldStacks(
      boardItems(heldView, []).get('todo') ?? [],
      'todo',
      heldView,
      false,
    );
    if (!isStackItem(item)) throw new Error('no stack face');
    return renderToStaticMarkup(
      <StackFace
        projectId="p1"
        item={item}
        canOperate
        actions={actions}
        defaultOpen
        onOpenCard={() => undefined}
      />,
    );
  };

  test('a later stage whose dependency has no ready PR shows a disabled Run naming it', () => {
    const html = renderWith([dep(1, 'completed'), dep(2, 'in_progress')]);
    expect(html).toContain('Run C-4: Waits for C-2');
    // C-2 has no dependency and stays runnable.
    expect(html).not.toContain('Run C-2:');
  });

  test('every dependency Finished or Completed leaves Run enabled', () => {
    const html = renderWith([dep(1, 'completed'), dep(2, 'finished')]);
    expect(html).not.toContain('Run C-4:');
    expect(html).not.toContain('Waits for');
  });
});
