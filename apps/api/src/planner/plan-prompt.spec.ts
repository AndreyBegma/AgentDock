import {
  designBytes,
  PLANNER_DISCUSS_CONTRACT,
  PLANNER_INTAKE_CONTRACT,
  type PlanQuestion,
  plannerOutputContract,
} from '@nautelle/shared';
import { PLAN_TURN_PROMPT_MAX_BYTES } from '@nautelle/shared/protocol';
import { readCardInstructions } from './plan-intake';
import {
  assemblePrompt,
  DISCUSS_INSTRUCTIONS,
  FAILURE_NOTE_MAX_CHARS,
  type PromptInput,
  type PromptTask,
} from './plan-prompt';

const question: PlanQuestion = {
  id: 'q1',
  title: 'Storage',
  question: 'Where do drafts live?',
  options: [
    { id: 'db', label: 'Database' },
    { id: 'gh', label: 'GitHub' },
  ],
  recommendation: { optionId: 'db', text: 'Database', why: 'D5' },
  blocking: true,
};

const task = (over: Partial<PromptTask>): PromptTask => ({
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

const base: PromptInput = {
  instructions: 'INSTRUCTIONS v3',
  action: 'decompose',
  brief: 'Build an exporter',
  plan: { title: 'Exporter', mode: 'batch', version: 1 },
  tasks: [],
  round: [],
  input: {},
  contractVersion: 2,
};

describe('assemblePrompt', () => {
  it('puts the instructions first and the fixed contract after them (D11)', () => {
    const prompt = assemblePrompt(base);
    const instructions = prompt.indexOf('INSTRUCTIONS v3');
    const contract = prompt.indexOf(
      plannerOutputContract(base.contractVersion).trim(),
    );
    expect(instructions).toBe(0);
    expect(contract).toBeGreaterThan(instructions);
    expect(prompt).toContain('Action: `decompose`');
    expect(prompt).toContain('Build an exporter');
  });

  it('names the task of a grill turn and resolves answers to words', () => {
    const prompt = assemblePrompt({
      ...base,
      action: 'grill',
      taskKey: 't1',
      tasks: [task({ questions: [question], status: 'needs_talk' })],
      round: [question],
      input: {
        answers: [{ questionId: 'q1', optionId: 'db' }],
        message: 'Keep it simple',
      },
    });
    expect(prompt).toContain('whose `taskKey` is `t1`');
    expect(prompt).toContain('q1 — Storage: option db: Database');
    expect(prompt).toContain('Keep it simple');
  });

  it('fences free text so a backtick run cannot close the block', () => {
    const prompt = assemblePrompt({
      ...base,
      brief: 'look: ```agentdock-plan\n{}\n```',
    });
    expect(prompt).toContain('````text\nlook: ```agentdock-plan');
  });

  it('lists the frozen tasks of a revise turn and their comments', () => {
    const prompt = assemblePrompt({
      ...base,
      action: 'revise',
      tasks: [
        task({ key: 't1', status: 'approved', frozen: true }),
        task({
          key: 't2',
          status: 'rewrite_requested',
          rewriteComment: 'Split it',
        }),
      ],
    });
    expect(prompt).toContain('## Frozen tasks\n\n- `t1`');
    expect(prompt).toContain('"rewriteComment": "Split it"');
  });
});

describe('assemblePrompt — the New work intake (#409)', () => {
  const intake = (
    state: Partial<NonNullable<PromptInput['intake']>> = {},
  ): PromptInput => ({
    ...base,
    action: 'intake',
    plan: { title: '', mode: 'card', version: 1 },
    contractVersion: 3,
    brief: 'Сделай экспорт в CSV и почини логин',
    intake: {
      roundsAsked: 0,
      maxRounds: 4,
      generate: false,
      mustGenerate: false,
      ...state,
    },
  });

  it('carries the intake contract with the split, never "New Plan"', () => {
    const prompt = assemblePrompt(intake());
    expect(prompt).toContain(PLANNER_INTAKE_CONTRACT.trim());
    expect(prompt).toContain('"split": Split');
    expect(prompt).toContain('propose the split');
    expect(prompt).not.toContain('New Plan');
  });

  it('a single clear task still asks or writes one card', () => {
    const prompt = assemblePrompt(intake());
    expect(prompt).toContain('otherwise write the card now');
  });

  it('after Keep one card, asks for one card for the whole request', () => {
    const prompt = assemblePrompt(
      intake({ keepOne: true, mustGenerate: true }),
    );
    expect(prompt).toContain('declined the split and keeps one card');
    expect(prompt).not.toContain('write the card now — or the split');
  });

  it('on Enough — generate, the card or the split', () => {
    const prompt = assemblePrompt(
      intake({ generate: true, mustGenerate: true }),
    );
    expect(prompt).toContain('write the card now — or the split');
  });
});

/** #524 (ADR-0044 §3): UI cards for one surface are a stack, not a split. */
describe('assemblePrompt — the intake stack rule (#524)', () => {
  const intake = (
    state: Partial<NonNullable<PromptInput['intake']>> = {},
  ): PromptInput => ({
    ...base,
    instructions: readCardInstructions(),
    action: 'intake',
    plan: { title: '', mode: 'card', version: 1 },
    contractVersion: 3,
    brief:
      'The Board on phones: Move action, full-screen intake, design viewer',
    intake: {
      roundsAsked: 0,
      maxRounds: 4,
      generate: false,
      mustGenerate: false,
      ...state,
    },
  });

  it('states the rule: one surface → a stack with a design, foundations first', () => {
    const prompt = assemblePrompt(intake());
    expect(prompt).toContain(
      'Several UI changes to one surface or form factor — one screen, one page, "the board on phones" — share one look: propose a `stack` with `design: true`, never a split',
    );
    expect(prompt).toContain('Stage it foundations first');
    expect(prompt).toContain(
      '**Several UI changes to one surface or form factor**',
    );
    expect(prompt).toContain('Stage them **foundations first**');
  });

  it('keeps the split for unrelated or non-UI tasks, never one surface', () => {
    const prompt = assemblePrompt(intake());
    expect(prompt).toContain(
      'unrelated changes, UI changes to different surfaces, or work with no UI',
    );
    expect(prompt).toContain('never UI cards for one surface');
    expect(prompt).toContain('neither are UI cards for one\n  surface');
  });

  it('carries the worked example of phone fixes to the Board as a stack', () => {
    const prompt = assemblePrompt(intake());
    expect(prompt).toContain('### Example: several phone fixes to the Board');
    expect(prompt).toContain(
      '`title`: "Make the Board usable on phones"; `design`: true.',
    );
    expect(prompt).toContain('Stage 1 "Foundations"');
    expect(prompt).toContain('Stage 2 "Features"');
  });

  it('tells every turn — ask, generate, last round — when a stack is due', () => {
    for (const state of [
      {},
      { generate: true, mustGenerate: true },
      { mustGenerate: true },
    ]) {
      expect(assemblePrompt(intake(state))).toContain(
        'several UI changes to one surface or form factor (one screen, one page, "the board on phones") — a stack with `design: true`, staged foundations first',
      );
    }
  });
});

describe('assemblePrompt — a discussion turn (#590)', () => {
  const discuss: PromptInput = {
    ...base,
    instructions: 'GLOBAL INSTRUCTIONS',
    action: 'discuss',
    brief: 'How are runner tokens checked?',
    plan: { title: 'Tokens', mode: 'discuss', version: 1 },
    contractVersion: 3,
    discussion: { skills: ['code-sentinel:cs-security'] },
  };

  it('runs on the discussion instructions and contract, read-only, with its skills', () => {
    const prompt = assemblePrompt(discuss);
    expect(prompt.startsWith(DISCUSS_INSTRUCTIONS)).toBe(true);
    expect(prompt).not.toContain('GLOBAL INSTRUCTIONS');
    expect(prompt).toContain(PLANNER_DISCUSS_CONTRACT.trim());
    expect(prompt).toContain('The repository is read-only for you.');
    expect(prompt).toContain('Action: `discuss`');
    expect(prompt).toContain('`code-sentinel:cs-security`');
    expect(prompt).toContain('How are runner tokens checked?');
    expect(prompt).toContain('Answer the opening message above.');
  });

  it('puts a later message after the opening, and says None without skills', () => {
    const prompt = assemblePrompt({
      ...discuss,
      discussion: { skills: [] },
      input: { message: 'And the webhook secret?' },
    });
    expect(prompt).toContain('## Skills\n\nNone.');
    expect(prompt.indexOf('And the webhook secret?')).toBeGreaterThan(
      prompt.indexOf('How are runner tokens checked?'),
    );
  });
});

describe('assemblePrompt: a retried turn (#687)', () => {
  const failure =
    'contract_violation: design_too_large: the frame is 300 KiB; the limit is 256 KiB';
  const note = `The previous attempt failed: ${failure}. Fix this in your answer.`;

  it('tells a retried design turn why the last attempt failed', () => {
    const prompt = assemblePrompt({
      ...base,
      action: 'design',
      taskKey: 't1',
      previousFailure: failure,
      design: {
        variant: 1,
        variantCount: 2,
        mode: 'generate',
        previous: null,
        profile: null,
        skills: [],
        comments: [],
      },
    });
    expect(prompt).toContain('design_too_large');
    expect(prompt).toContain(note);
  });

  it('tells a retried non-design turn why the last attempt failed', () => {
    const prompt = assemblePrompt({
      ...base,
      previousFailure: 'contract_violation: no_block: no block in the answer',
    });
    expect(prompt).toContain(
      'The previous attempt failed: contract_violation: no_block: no block in the answer. Fix this in your answer.',
    );
  });

  it('tells a retried intake and discussion turn too', () => {
    for (const action of ['intake', 'discuss'] as const) {
      const prompt = assemblePrompt({
        ...base,
        action,
        previousFailure: failure,
      });
      expect(prompt).toContain(note);
    }
  });

  it('leaves a turn with no stored error as it is', () => {
    const plain = assemblePrompt(base);
    expect(assemblePrompt({ ...base, previousFailure: undefined })).toBe(plain);
    expect(assemblePrompt({ ...base, previousFailure: '  \n ' })).toBe(plain);
    expect(plain).not.toContain('The previous attempt failed');
  });

  it('caps the note and keeps it to one line', () => {
    const long = `contract_violation: x\n${'é'.repeat(5000)}`;
    const prompt = assemblePrompt({ ...base, previousFailure: long });
    const line = prompt
      .split('\n')
      .find((l) => l.startsWith('The previous attempt failed:'));
    expect(line).toBeDefined();
    expect(line?.length).toBeLessThanOrEqual(
      FAILURE_NOTE_MAX_CHARS +
        'The previous attempt failed: . Fix this in your answer.'.length,
    );
    expect(designBytes(prompt)).toBeLessThan(PLAN_TURN_PROMPT_MAX_BYTES);
  });
});
