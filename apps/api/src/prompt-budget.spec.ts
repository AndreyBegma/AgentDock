import {
  type PlanQuestion,
  type PlanTurnAction,
  plannerOutputContract,
} from '@agentdock/shared';
import { systemPrompt } from './assistant/prompts';
import { readDefaultPlannerInstructions } from './database/seed-planner-instructions';
import {
  cardDesignPrompt,
  type DesignPromptContext,
  stackDesignPrompt,
} from './design/design-prompt';
import { readCardInstructions } from './planner/plan-intake';
import {
  assemblePrompt,
  DISCUSS_INSTRUCTIONS,
  type PromptInput,
  type PromptTask,
} from './planner/plan-prompt';

/**
 * C-254: every launch prompt has a token budget (bytes ÷ 4), and its static
 * instructions come first, so the prompt cache reuses the prefix across runs.
 * A prompt that outgrows its budget fails here; raise a budget only on
 * purpose, in the same change that explains why the prompt grew.
 */
const tokens = (text: string): number =>
  Math.ceil(new TextEncoder().encode(text).length / 4);

const commonPrefix = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

const question: PlanQuestion = {
  id: 'q1',
  title: 'Storage',
  question: 'Where do drafts live?',
  options: [{ id: 'db', label: 'Database' }],
  recommendation: { optionId: 'db', text: 'Database', why: 'D5' },
  blocking: false,
};

const task = (over: Partial<PromptTask> = {}): PromptTask => ({
  key: 't1',
  kind: 'feature',
  title: 'Export',
  summary: 'Export plans',
  dependsOn: [],
  status: 'ready',
  frozen: false,
  questions: [],
  document: null,
  rewriteComment: null,
  ...over,
});

const design: DesignPromptContext = {
  variant: 1,
  variantCount: 1,
  mode: 'generate',
  previous: null,
  profile: null,
  skills: [],
  comments: [],
};

const planInstructions = readDefaultPlannerInstructions();
const cardInstructions = readCardInstructions();

/** One planner turn of `action`, for a brief only the test names. */
const turn = (action: PlanTurnAction, brief: string): PromptInput => ({
  instructions: action === 'intake' ? cardInstructions : planInstructions,
  action,
  brief,
  plan: {
    title: brief,
    mode: action === 'intake' ? 'card' : 'batch',
    version: 1,
  },
  tasks: [task({ title: brief })],
  taskKey: ['grill', 'write', 'design'].includes(action) ? 't1' : undefined,
  round: [question],
  input: { message: brief },
  contractVersion: action === 'intake' || action === 'discuss' ? 3 : 2,
  hasUi: true,
  ...(action === 'design' ? { design } : {}),
  ...(action === 'intake'
    ? {
        intake: {
          roundsAsked: 0,
          maxRounds: 4,
          generate: false,
          mustGenerate: false,
        },
      }
    : {}),
  ...(action === 'discuss' ? { discussion: { skills: [] } } : {}),
});

/** Tokens per plan turn with a one-line brief; the real instructions and the output contract are in it. */
const PLAN_TURN_BUDGET: Record<PlanTurnAction, number> = {
  clarify: 3950,
  decompose: 3950,
  grill: 3950,
  write: 3950,
  revise: 3950,
  design: 4050,
  intake: 2700,
  discuss: 700,
};

describe('prompt budgets — plan turns (C-254)', () => {
  for (const action of Object.keys(PLAN_TURN_BUDGET) as PlanTurnAction[]) {
    it(`the ${action} turn stays within its budget`, () => {
      const size = tokens(assemblePrompt(turn(action, 'Build an exporter')));
      expect(size).toBeLessThanOrEqual(PLAN_TURN_BUDGET[action]);
    });

    it(`the ${action} turn has the same static prefix for two different briefs`, () => {
      const a = assemblePrompt(turn(action, 'Build an exporter'));
      const b = assemblePrompt(turn(action, 'Fix the importer'));
      const shared = commonPrefix(a, b);
      // The instructions and the output contract — the cached part.
      const instructions =
        action === 'intake'
          ? cardInstructions
          : action === 'discuss'
            ? DISCUSS_INSTRUCTIONS
            : planInstructions;
      const staticPart = instructions.trim();
      expect(shared).toBeGreaterThan(staticPart.length);
      expect(a.slice(0, shared)).not.toContain('exporter');
      expect(a.slice(0, shared)).not.toContain('Fix the importer');
    });
  }

  it('the output contract follows the instructions in the shared prefix', () => {
    const a = assemblePrompt(turn('decompose', 'Build an exporter'));
    const b = assemblePrompt(turn('decompose', 'Fix the importer'));
    const shared = a.slice(0, commonPrefix(a, b));
    expect(shared).toContain(plannerOutputContract(2).trim());
  });
});

describe('prompt budgets — design turns (C-254)', () => {
  const card = (title: string) =>
    cardDesignPrompt({
      instructions: planInstructions,
      card: { number: 12, title, body: `Do ${title}.` },
      taskKey: 'card-12',
      design,
    });
  const stack = (title: string) =>
    stackDesignPrompt({
      instructions: planInstructions,
      stack: {
        number: 3,
        title,
        body: `Do ${title}.`,
        stages: [{ title: 'One', cards: ['C-1 First'] }],
      },
      taskKey: 'stack-3',
      design,
    });

  it('stay within their budgets', () => {
    expect(tokens(card('Add login'))).toBeLessThanOrEqual(3950);
    expect(tokens(stack('Redesign the board'))).toBeLessThanOrEqual(4000);
  });

  it('share the instructions and the contract across two different cards', () => {
    for (const build of [card, stack]) {
      const a = build('Add login');
      const b = build('Fix the export');
      const shared = a.slice(0, commonPrefix(a, b));
      expect(shared.length).toBeGreaterThan(planInstructions.trim().length);
      expect(shared).not.toContain('login');
    }
  });
});

describe('prompt budgets — the assistant (C-254)', () => {
  const project = {
    id: 'p1',
    displayName: 'Nautelle',
    repo: 'a/b',
    role: 'owner',
  };
  const prompt = (email: string, day: number) =>
    systemPrompt({
      now: new Date(Date.UTC(2026, 9, day)),
      user: { email, role: 'admin' },
      project,
      ambiguous: [],
      codeTools: { read: true, ask: true },
    });

  it('stays within its budget', () => {
    // 370 before the code tools (#622) added about 90 with all three offered.
    expect(tokens(prompt('a@b.c', 1))).toBeLessThanOrEqual(470);
  });

  it('keeps the date, the person and the project after the instructions', () => {
    const a = prompt('one@x.io', 1);
    const b = prompt('two@x.io', 2);
    const shared = a.slice(0, commonPrefix(a, b));
    expect(shared).toContain('## Language');
    expect(shared).not.toContain('@x.io');
    expect(shared).not.toContain('Nautelle (a/b)');
  });
});

describe('prompt budgets — the instruction files (C-254)', () => {
  it('stay within their budgets', () => {
    expect(tokens(planInstructions)).toBeLessThanOrEqual(2500);
    expect(tokens(cardInstructions)).toBeLessThanOrEqual(1250);
  });
});
