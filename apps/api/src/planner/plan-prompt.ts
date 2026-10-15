import {
  answerOptionIds,
  designBytes,
  PLANNER_BLOCK_TAG,
  PLANNER_DESIGN_CONTRACT,
  PLANNER_INTAKE_CONTRACT,
  type PlanMode,
  type PlannerContractVersion,
  type PlanQuestion,
  type PlanTaskKind,
  type PlanTaskStatus,
  type PlanTurnAction,
  type PlanTurnInput,
  plannerOutputContract,
} from '@agentdock/shared';
import { PLAN_TURN_PROMPT_MAX_BYTES } from '@agentdock/shared/protocol';
import {
  type ApprovedDesignContext,
  approvedDesignSections,
  type DesignPromptContext,
  designSections,
  designWhat,
} from '../design/design-prompt';

/** A task as the planner sees it in the plan state. */
export interface PromptTask {
  key: string;
  kind: PlanTaskKind;
  title: string;
  summary: string;
  dependsOn: string[];
  status: PlanTaskStatus;
  frozen: boolean;
  questions: PlanQuestion[];
  document: string | null;
  rewriteComment: string | null;
}

export interface PromptInput {
  /** The instructions version the plan runs with (D11). */
  instructions: string;
  action: PlanTurnAction;
  brief: string;
  plan: { title: string; mode: PlanMode; version: number };
  tasks: PromptTask[];
  /** The task of a grill or write turn. */
  taskKey?: string;
  /** The round the input answers: the plan's for clarify, the task's for grill. */
  round: PlanQuestion[];
  input: PlanTurnInput;
  /** The plan's contract version (D11): its turns run under it. */
  contractVersion: PlannerContractVersion;
  /**
   * Spec 223 D3: whether the project's UI profile reports a UI — null with no
   * profile. Told to v2 turns that suggest designs.
   */
  hasUi?: boolean | null;
  /** Spec 223 D8: a design turn's context. */
  design?: DesignPromptContext;
  /** Spec 223 D16: a write turn of a task whose design is approved. */
  approvedDesign?: ApprovedDesignContext;
  /** #337 D4: an intake turn's state — rounds asked, and whether it must write the card. */
  intake?: IntakePromptState;
  /**
   * #337 D9: a project's own Planner instructions, for an intake — whose
   * `instructions` are the card-mode ones.
   */
  projectInstructions?: string | null;
  /** #337 D10: the worktree paths of the files the runner placed for the turn. */
  attachments?: readonly string[];
}

export interface IntakePromptState {
  roundsAsked: number;
  maxRounds: number;
  /** The person pressed Enough — generate (D3). */
  generate: boolean;
  /** No fifth round, and none after Enough (`intakeMustGenerate`). */
  mustGenerate: boolean;
}

/** Actions whose output carries design suggestions under contract v2. */
const SUGGESTING: readonly PlanTurnAction[] = ['decompose', 'grill', 'revise'];

const WHAT: Record<PlanTurnAction, (input: PromptInput) => string> = {
  clarify: () =>
    'Ask the next round of plan-level questions about the brief, or report `done: true` when the brief is clear enough to split into tasks.',
  decompose: () =>
    'Split the brief into tasks. Each task is one bug or one feature, with its dependencies and the questions it still needs answered.',
  grill: (i) =>
    `Talk task \`${i.taskKey}\` through: ask the next round of questions about it, or report \`done: true\` when it can be written.`,
  write: (i) =>
    `Write the document of task \`${i.taskKey}\`. Use the answers given so far; record every default you took under \`## Open questions\`.`,
  revise: () =>
    'Revise the plan. Apply every rewrite comment. Pass every frozen (approved) task through as `{ "key": "<key>" }` only, drop rejected tasks, and return every other task in full.',
  design: (i) =>
    i.design
      ? designWhat(`task \`${i.taskKey ?? ''}\``, i.design)
      : `Draw the mockup of task \`${i.taskKey}\`.`,
  intake: (i) => {
    const state = i.intake;
    if (!state) {
      return 'Interview the person about the card they asked for: ask the next round of questions, or write the card when nothing material is unknown.';
    }
    const asked = `Rounds asked so far: ${state.roundsAsked} of ${state.maxRounds}.`;
    if (state.generate) {
      return `${asked} The person asked to generate: write the card now. Every question they left unanswered takes its recommendation — record those under \`## Open questions\`.`;
    }
    if (state.mustGenerate) {
      return `${asked} No more rounds may be asked: write the card now, recording every default you took under \`## Open questions\`.`;
    }
    return `${asked} Ask the next round of questions only if something material is still unknown; otherwise write the card now.`;
  },
};

const UI_LINE = {
  true: 'The project has a user interface (its UI profile says so).',
  false:
    'The project has no user interface (its UI profile says so): every `design.needed` is `false`.',
  none: 'The project has no UI profile yet; judge from the brief and the repository.',
} as const;

const fence = (lang: string, body: string): string => {
  // A fence longer than any backtick run inside, so the body cannot close it.
  const longest = Math.max(
    2,
    ...[...body.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${body}\n${ticks}`;
};

/** A round's answers with the question and option they refer to, so the model reads words, not ids. */
const answersText = (
  round: readonly PlanQuestion[],
  input: PlanTurnInput,
): string[] =>
  (input.answers ?? []).map((a) => {
    const question = round.find((q) => q.id === a.questionId);
    const head = question
      ? `${question.id} — ${question.title}`
      : `${a.questionId} (not in the current round)`;
    // #337 D3: a multiple-choice answer picks several.
    const picked = answerOptionIds(a).map((id) => {
      const option = question?.options.find((o) => o.id === id);
      return option ? `option ${option.id}: ${option.label}` : `option ${id}`;
    });
    const parts = [...picked, ...(a.text ? [`answer: ${a.text}`] : [])];
    return `- ${head}: ${parts.join('; ')}`;
  });

/**
 * The prompt of one turn (D16): the instructions, the fixed output contract,
 * the action, the brief, the plan state and the person's input. It reaches
 * the runner as one string field and `claude -p` on stdin — never a shell
 * string. Free text from the person is fenced, so it reads as data.
 */
export const assemblePrompt = (input: PromptInput): string => {
  const design = input.design;
  if (!design) return assembleWith(input, []);
  // Spec 223: a large style kit's snippets are trimmed from the end until
  // the prompt fits its cap; the prompt says which were left out.
  const count = design.profile?.snippets.length ?? 0;
  let prompt = assembleWith(input, designSections(design));
  for (
    let keep = count - 1;
    keep >= 0 && designBytes(prompt) > PLAN_TURN_PROMPT_MAX_BYTES;
    keep -= 1
  ) {
    prompt = assembleWith(input, designSections(design, keep));
  }
  return prompt;
};

/** The person's input of a turn: the last round's answers, then their message. */
const inputSections = (input: PromptInput): string[] => {
  const sections: string[] = [];
  const answers = answersText(input.round, input.input);
  if (answers.length > 0) {
    sections.push(
      '## Answers to the last round',
      fence('text', answers.join('\n')),
    );
  }
  if (input.input.message) {
    sections.push('## Message', fence('text', input.input.message));
  }
  return sections;
};

/**
 * #337 D1, D4–D6: an intake turn — the card-mode instructions, the project's
 * own (D9), the intake contract in place of the plan's, what the person asked
 * for as typed (D5), and the files placed for the turn (D10).
 */
const assembleIntake = (input: PromptInput): string => {
  const sections = [
    input.instructions.trim(),
    ...(input.projectInstructions?.trim()
      ? [
          '# Project instructions',
          "The project's own Planner instructions. Where they speak about splitting plans or writing documents, they do not apply to a card intake; everything they say about the project does.",
          input.projectInstructions.trim(),
        ]
      : []),
    PLANNER_INTAKE_CONTRACT.trim(),
    '# This turn',
    `Action: \`intake\`. ${WHAT.intake(input)}`,
    `Answer with exactly one \`${PLANNER_BLOCK_TAG}\` block whose \`action\` is \`intake\`.`,
    '## What the person asked for',
    fence('text', input.brief),
  ];
  if (input.attachments && input.attachments.length > 0) {
    sections.push(
      '## Attached files',
      'The person attached these files; they are in your working directory. Read them — a screenshot shows what they mean.',
      input.attachments.map((path) => `- \`${path}\``).join('\n'),
    );
  }
  sections.push(...inputSections(input));
  return `${sections.join('\n\n')}\n`;
};

const assembleWith = (input: PromptInput, design: string[]): string => {
  if (input.action === 'intake') return assembleIntake(input);
  const state = {
    title: input.plan.title,
    mode: input.plan.mode,
    version: input.plan.version,
    tasks: input.tasks.map((t) => ({
      key: t.key,
      kind: t.kind,
      title: t.title,
      summary: t.summary,
      dependsOn: t.dependsOn,
      status: t.status,
      frozen: t.frozen,
      ...(t.questions.length > 0 ? { questions: t.questions } : {}),
      ...(t.rewriteComment ? { rewriteComment: t.rewriteComment } : {}),
      ...(t.document && t.key === input.taskKey
        ? { document: t.document }
        : {}),
    })),
  };
  const v2 = input.contractVersion >= 2;
  const sections = [
    input.instructions.trim(),
    plannerOutputContract(input.contractVersion).trim(),
    // Spec 223: a v1 plan's design is switched on by hand; its contract text
    // does not carry the design action, so a design turn gets it here.
    ...(input.action === 'design' && !v2
      ? [PLANNER_DESIGN_CONTRACT.trim()]
      : []),
    '# This turn',
    `Action: \`${input.action}\`. ${WHAT[input.action](input)}`,
    `Answer with exactly one \`${PLANNER_BLOCK_TAG}\` block whose \`action\` is \`${input.action}\`${input.taskKey ? ` and whose \`taskKey\` is \`${input.taskKey}\`` : ''}.`,
    '## Brief',
    fence('text', input.brief),
    '## Plan state',
    fence('json', JSON.stringify(state, null, 2)),
  ];
  if (v2 && SUGGESTING.includes(input.action) && input.hasUi !== undefined) {
    sections.push(
      '## User interface',
      UI_LINE[input.hasUi === null ? 'none' : input.hasUi ? 'true' : 'false'],
    );
  }
  sections.push(...design);
  if (input.approvedDesign) {
    sections.push(...approvedDesignSections(input.approvedDesign));
  }
  if (input.action === 'revise') {
    const frozen = input.tasks.filter((t) => t.status === 'approved');
    sections.push(
      '## Frozen tasks',
      frozen.length > 0
        ? frozen.map((t) => `- \`${t.key}\``).join('\n')
        : 'None.',
    );
  }
  sections.push(...inputSections(input));
  return `${sections.join('\n\n')}\n`;
};
