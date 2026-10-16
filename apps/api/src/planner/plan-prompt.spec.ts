import {
  PLANNER_INTAKE_CONTRACT,
  type PlanQuestion,
  plannerOutputContract,
} from '@agentdock/shared';
import {
  assemblePrompt,
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
