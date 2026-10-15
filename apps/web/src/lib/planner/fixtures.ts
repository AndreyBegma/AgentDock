import type {
  PlanDetail,
  PlanQuestion,
  PlanTaskView,
  PlanTurnView,
} from '@agentdock/shared';

/** Planner fixtures for the tests: a batch plan of three tasks, mid-review. */

export const question = (over: Partial<PlanQuestion> = {}): PlanQuestion => ({
  id: 'q1',
  title: 'Storage',
  question: 'Where do drafts live?',
  options: [
    { id: 'db', label: 'Database' },
    { id: 'gh', label: 'GitHub drafts' },
  ],
  recommendation: { optionId: 'db', text: 'Database', why: 'Nothing leaks.' },
  blocking: true,
  ...over,
});

export const task = (over: Partial<PlanTaskView> = {}): PlanTaskView => ({
  id: 'task-t1',
  key: 't1',
  planVersion: 1,
  kind: 'feature',
  title: 'Planner contract',
  summary: 'Types and parser.',
  dependsOn: [],
  status: 'ready',
  questions: [],
  blockingOpen: 0,
  document: '# Planner contract\n\n## Acceptance criteria\n\n- [ ] parses',
  rewriteComment: null,
  frozen: false,
  issue: null,
  queuedAt: null,
  design: null,
  ...over,
});

export const turn = (over: Partial<PlanTurnView> = {}): PlanTurnView => ({
  id: 'turn-1',
  planId: 'plan-1',
  taskKey: null,
  runId: 'run-1',
  action: 'decompose',
  author: { id: 'u1', name: 'Ada' },
  input: {},
  phase: 'succeeded',
  error: null,
  resultText: null,
  rounds: [],
  createdAt: '2026-10-13T10:00:00.000Z',
  finishedAt: '2026-10-13T10:02:00.000Z',
  ...over,
});

export const plan = (over: Partial<PlanDetail> = {}): PlanDetail => {
  const tasks = over.tasks ?? [
    task(),
    task({
      id: 'task-t2',
      key: 't2',
      kind: 'bug',
      title: 'Queue drops labels',
      dependsOn: ['t1'],
      status: 'needs_talk',
      questions: [question()],
      blockingOpen: 1,
      document: null,
    }),
    task({
      id: 'task-t3',
      key: 't3',
      title: 'Planner page',
      dependsOn: ['t1', 't2'],
      status: 'approved',
      frozen: true,
    }),
  ];
  return {
    id: 'plan-1',
    projectId: 'p1',
    title: 'Planner',
    author: { id: 'u1', name: 'Ada' },
    mode: 'batch',
    visibility: 'private',
    status: 'reviewing',
    version: 1,
    taskCounts: { ready: 1, needs_talk: 1, approved: 1 },
    createdAt: '2026-10-13T10:00:00.000Z',
    updatedAt: '2026-10-13T10:05:00.000Z',
    sentAt: null,
    brief: 'Move cs-spec into AgentDock.',
    questions: [],
    instructionsVersion: 1,
    contractVersion: 1,
    profileKey: 'default',
    model: 'opus',
    docsPrNumber: null,
    docsPrUrl: null,
    tasks,
    turns: [turn()],
    graph: {
      nodes: tasks.map((t) => ({ key: t.key, kind: t.kind, title: t.title })),
      edges: tasks.flatMap((t) =>
        t.dependsOn.map((d) => ({ from: d, to: t.key })),
      ),
    },
    activeTurnId: null,
    ...over,
  };
};
