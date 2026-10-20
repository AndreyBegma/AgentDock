import { describe, expect, test } from 'bun:test';
import {
  type BoardStackView,
  type PlanIntakeSplitView,
  STACK_GATE_REASON,
} from '@nautelle/shared';
import { boardView, card } from './fixtures';
import {
  addStage,
  confirmHint,
  confirmRequest,
  confirmText,
  dropFromStages,
  moveToStage,
  proposalTitle,
  proposedShape,
  SPLIT_HINT,
  splitRows,
  stackDraft,
  stackProblem,
} from './intake';
import { boardItems } from './plan-tasks';
import {
  addableCards,
  approvableRevision,
  designSwitch,
  gateNote,
  stageLinkText,
} from './stack-page';
import {
  foldStacks,
  isStackItem,
  stackDesignChip,
  stackStages,
  withoutStacks,
} from './stacks';

const ref = (stage: number) => ({
  number: 3,
  label: 'S-3',
  title: 'Redesign the Settings page',
  stage,
  stageTitle: stage === 0 ? 'Components' : 'Page',
  gate: STACK_GATE_REASON,
});

const stack = (over: Partial<BoardStackView> = {}): BoardStackView => ({
  run: null,
  id: 'stack-3',
  number: 3,
  label: 'S-3',
  title: 'Redesign the Settings page',
  column: 'todo',
  accepted: 1,
  total: 4,
  currentStage: 0,
  stages: [
    { position: 0, title: 'Components', cards: [1, 2, 3] },
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
  costUsd: null,
  ...over,
});

describe('a stack on the Board (#480)', () => {
  const cards = [
    card(1, 'completed', { stack: ref(0) }),
    card(2, 'in_progress', { stack: ref(0) }),
    card(3, 'todo', { stack: ref(0) }),
    card(4, 'todo', { stack: ref(1) }),
    card(5, 'todo'),
  ];
  const view = { ...boardView(cards), stacks: [stack()] };
  const items = boardItems(view, []);

  test('folds the cards in its column into one face, where the first of them was', () => {
    const todo = foldStacks(items.get('todo') ?? [], 'todo', view, false);
    expect(todo.map((i) => i.id)).toEqual(['stack:stack-3', 'card-5']);
    const face = todo[0];
    expect(isStackItem(face)).toBe(true);
    if (!isStackItem(face)) return;
    expect(face.foldedIds).toEqual(['card-3', 'card-4']);
    expect(face.cards.map((c) => c.number)).toEqual([1, 2, 3, 4]);
    expect(withoutStacks(todo).map((i) => i.id)).toEqual(['card-5']);
  });

  test('a card of the stack in another column stays on its own', () => {
    const progress = foldStacks(
      items.get('in_progress') ?? [],
      'in_progress',
      view,
      false,
    );
    expect(progress.map((i) => i.id)).toEqual(['card-2']);
  });

  test('expanded, it shows its cards by stage, each with its column', () => {
    const [face] = foldStacks(items.get('todo') ?? [], 'todo', view, false);
    if (!isStackItem(face)) throw new Error('no stack face');
    const stages = stackStages(face);
    expect(
      stages.map((s) => [s.name, s.cards.map((c) => c.column), s.accepted]),
    ).toEqual([
      ['Components', ['completed', 'in_progress', 'todo'], 1],
      ['Page', ['todo'], 0],
    ]);
    expect(stackDesignChip(face.stack)).toBe('Stack design not approved');
    expect(
      stackDesignChip(
        stack({ design: { ...stack().design!, status: 'approved' } }),
      ),
    ).toBeNull();
  });

  test('a stack whose cards the filter hides is not shown while filtering', () => {
    expect(foldStacks([], 'todo', view, true)).toEqual([]);
  });
});

const split: PlanIntakeSplitView = {
  turnId: 'turn-1',
  reason: 'Сначала компоненты, потом страница.',
  cards: [0, 1, 2].map((index) => ({
    index,
    title: `Build part ${index + 1} of the page`,
    kind: 'feature',
    summary: `Part ${index + 1}.`,
  })),
  stack: {
    title: 'Redesign the Settings page',
    body: 'Components first.',
    design: true,
    stages: [
      { title: 'Components', cards: [0, 1] },
      { title: 'Page', cards: [2] },
    ],
  },
};

describe('the intake review switches between Split and Stack (#480)', () => {
  test('opens in the shape the intake proposed', () => {
    expect(proposedShape(split)).toBe('stack');
    expect(proposedShape({ ...split, stack: null })).toBe('split');
    expect(proposalTitle(split)).toBe(
      'The planner proposes a stack of 3 cards in 2 stages',
    );
    // #524: a split turned into a stack starts foundations first, with one
    // shared design — the person moves the shared pieces up a stage.
    const turned = stackDraft({ ...split, stack: null });
    expect(turned.design).toBe(true);
    expect(turned.stages).toEqual([
      { title: 'Foundations', cards: [] },
      { title: 'Features', cards: [0, 1, 2] },
    ]);
    expect(moveToStage(turned, 0, -1).stages).toEqual([
      { title: 'Foundations', cards: [0] },
      { title: 'Features', cards: [1, 2] },
    ]);
  });

  test('the split view says UI cards for one surface are a stack (#524)', () => {
    expect(SPLIT_HINT).toContain('Independent cards');
    expect(SPLIT_HINT).toContain(
      'UI changes to one surface share one look — switch to Stack',
    );
  });

  test('moves a card between stages, adds a stage, and drops a removed card', () => {
    let draft = stackDraft(split);
    draft = moveToStage(draft, 1, 1);
    expect(draft.stages.map((s) => s.cards)).toEqual([[0], [2, 1]]);
    expect(moveToStage(draft, 0, -1)).toBe(draft);
    draft = addStage(draft);
    expect(draft.stages.at(-1)).toEqual({ title: 'Stage 3', cards: [] });
    draft = dropFromStages(draft, 0);
    expect(draft.stages[0].cards).toEqual([]);
  });

  test('confirms a stack in stage order without empty stages, or a split as it was', () => {
    const rows = splitRows(split);
    const draft = addStage(moveToStage(stackDraft(split), 0, 1));
    expect(confirmRequest('turn-1', 'stack', rows, draft)).toEqual({
      turnId: 'turn-1',
      cards: [1, 2, 0].map((index) => ({
        index,
        title: `Build part ${index + 1} of the page`,
        kind: 'feature',
      })),
      stack: {
        title: 'Redesign the Settings page',
        body: 'Components first.',
        design: true,
        stages: [
          { title: 'Components', cards: [1] },
          { title: 'Page', cards: [2, 0] },
        ],
      },
    });
    expect(
      confirmRequest('turn-1', 'split', rows, draft).stack,
    ).toBeUndefined();
    expect(confirmText('stack', 3)).toBe('Send stack to Drafts · 3 cards');
    expect(confirmText('split', 3)).toBe('Send 3 cards to Drafts');
    expect(confirmHint('stack', true)).toBe(
      'They wait in Drafts; once accepted, Run waits for the stack design.',
    );
  });

  test('a stack needs an English title and a card in a stage', () => {
    expect(stackProblem(stackDraft(split))).toBeNull();
    expect(stackProblem({ ...stackDraft(split), title: ' ' })).toBe(
      'A stack needs a title.',
    );
    expect(
      stackProblem({ ...stackDraft(split), title: 'Новая страница' }),
    ).toContain('English');
    expect(
      stackProblem({
        ...stackDraft(split),
        stages: [{ title: 'A', cards: [] }],
      }),
    ).toBe('A stack needs a card in a stage.');
  });
});

describe('the stack page (#480)', () => {
  test('names the stage links and the cards that keep running', () => {
    const detail = {
      stages: [
        {
          position: 0,
          title: 'Components',
          cards: [
            { label: 'C-1', round: null, column: 'todo' },
            { label: 'C-2', round: { round: 1 }, column: 'in_progress' },
            { label: 'C-3', round: null, column: 'todo' },
          ],
        },
        {
          position: 1,
          title: 'Page',
          cards: [
            { label: 'C-4', round: null, column: 'todo' },
            { label: 'C-5', round: null, column: 'todo' },
          ],
        },
      ],
    } as never;
    expect(stageLinkText(detail, 1)).toBe(
      'Every card of Stage 2 waits on all of Stage 1 · 6 dependencies',
    );
    expect(gateNote(detail)).toBe(
      'Nothing writes project code until the stack design is approved. C-2 was started before the design held the stack and keeps running.',
    );
  });

  test('approves from the page only when one variant is in play', () => {
    const revision = (id: string, variant: number, n: number) =>
      ({ id, variant, revision: n, archived: false }) as never;
    const design = {
      status: 'reviewing',
      revisions: [revision('r1', 1, 1), revision('r2', 1, 2)],
    } as never;
    expect(approvableRevision(design)?.id).toBe('r2');
    expect(
      approvableRevision({
        status: 'reviewing',
        revisions: [revision('r1', 1, 1), revision('r3', 2, 1)],
      } as never),
    ).toBeNull();
  });

  test('Add card offers the cards in no stack, not suggestions, not accepted', () => {
    const view = boardView([
      card(1, 'todo', { stack: ref(0) }),
      card(2, 'todo'),
      card(3, 'inbox'),
      card(4, 'completed'),
      card(5, 'in_progress'),
    ]);
    expect(addableCards(view).map((c) => c.number)).toEqual([2, 5]);
  });

  test('#502: the design switch is on while the design is needed and locked while a turn runs', () => {
    const design = (status: string) => ({ design: { status } }) as never;
    expect(designSwitch({ design: null })).toEqual({
      required: false,
      locked: false,
    });
    expect(designSwitch(design('approved'))).toEqual({
      required: true,
      locked: false,
    });
    expect(designSwitch(design('generating')).locked).toBe(true);
    expect(designSwitch(design('revising')).locked).toBe(true);
  });
});
