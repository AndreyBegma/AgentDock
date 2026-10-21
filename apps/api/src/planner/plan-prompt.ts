import {
  answerOptionIds,
  PLANNER_BLOCK_TAG,
  PLANNER_DESIGN_CONTRACT,
  PLANNER_DISCUSS_CONTRACT,
  PLANNER_INTAKE_CONTRACT,
  type PlanMode,
  type PlannerContractVersion,
  type PlanQuestion,
  type PlanTaskKind,
  type PlanTaskStatus,
  type PlanTurnAction,
  type PlanTurnInput,
  plannerOutputContract,
} from '@nautelle/shared';
import {
  type ApprovedDesignContext,
  approvedDesignSections,
  type DesignPromptContext,
  designSections,
  designWhat,
  fitDesignPrompt,
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
  /** #590: a discussion turn's skills — the installed ones of those it chose. */
  discussion?: DiscussPromptState;
  /** #687: the stored error of the failed turn this one retries. */
  previousFailure?: string;
}

/** #687: the characters of a failure reason a retried prompt carries. */
export const FAILURE_NOTE_MAX_CHARS = 600;

/**
 * #687: what a retried turn is told of the failure before it — one line, so a
 * runner's multi-line error reads as a reason, and capped so it cannot push a
 * prompt past its byte cap. Nothing for a turn that stored no error.
 */
const failureSections = (input: PromptInput): string[] => {
  const reason = input.previousFailure?.replace(/\s+/g, ' ').trim();
  if (!reason) return [];
  const clipped =
    reason.length > FAILURE_NOTE_MAX_CHARS
      ? `${reason.slice(0, FAILURE_NOTE_MAX_CHARS - 1)}…`
      : reason;
  return [
    '## Previous attempt',
    `The previous attempt failed: ${clipped}. Fix this in your answer.`,
  ];
};

export interface DiscussPromptState {
  skills: readonly string[];
}

/**
 * #590 (ADR-0056): what a discussion turn is — the instructions every turn
 * of a `discuss` plan runs on, in place of the planner's. The turn runs in
 * the plan's read-only worktree (spec 172 D15), so the model reads the
 * repository and cannot change it; the instructions say so as well.
 */
export const DISCUSS_INSTRUCTIONS = `# Discussion

You are the project's planning model, in a free conversation with a person
about this repository. They ask questions about the code and the
architecture, or ask for an analysis — security, performance, architecture,
anything about the code.

- Read the repository to answer: open the files, follow the calls, quote the
  paths and lines you rely on. Say what you checked and what you did not.
- The repository is read-only for you. Never edit, create or delete a file,
  never commit, never run a command that changes anything. A discussion
  changes nothing in the project.
- Answer what was asked, as a reviewer would: findings first, ordered by
  risk or importance, each with where it is and what to do about it.
- Questions about the board, the fleet, budgets or sessions are not yours to
  answer: say so, and stay with the code.
- A discussion does not have to end in work. Propose a card only for
  concrete work your answer found; the person decides whether to make it.`;

export interface IntakePromptState {
  roundsAsked: number;
  maxRounds: number;
  /** The person pressed Enough — generate (D3). */
  generate: boolean;
  /** No fifth round, and none after Enough (`intakeMustGenerate`). */
  mustGenerate: boolean;
  /** #409: the person declined the split — one card, for the whole request. */
  keepOne?: boolean;
}

/** Actions whose output carries design suggestions under contract v2. */
const SUGGESTING: readonly PlanTurnAction[] = ['decompose', 'grill', 'revise'];

/**
 * #524 (ADR-0044 §3): when an intake proposes a split, and when a stack —
 * several UI changes to one surface share one look, so they are a stack.
 */
const SPLIT_WHEN =
  'several independent tasks (unrelated changes, UI changes to different surfaces, or work with no UI) or too big for one agent';
const STACK_WHEN =
  'one larger piece of work whose parts must happen in order and share one look, or several UI changes to one surface or form factor (one screen, one page, "the board on phones") — a stack with `design: true`, staged foundations first: the shared layout and primitives, then the per-feature cards';

const WHAT: Record<PlanTurnAction, (input: PromptInput) => string> = {
  discuss: () =>
    "Answer the person's latest message in the discussion. Propose cards only for concrete work you found.",
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
      return `Interview the person about the work they asked for: ask the next round of questions, or — when nothing material is unknown — write the card, or propose a split if it is ${SPLIT_WHEN}, or a stack if it is ${STACK_WHEN}.`;
    }
    const asked = `Rounds asked so far: ${state.roundsAsked} of ${state.maxRounds}.`;
    if (state.keepOne) {
      return `${asked} The person declined the split and keeps one card: write one \`cardDraft\` now that covers the whole request. Record every default you took under \`## Open questions\`.`;
    }
    if (state.generate) {
      return `${asked} The person asked to generate: write the card now — or the split if the request is ${SPLIT_WHEN}, or the stack if it is ${STACK_WHEN}. Every question they left unanswered takes its recommendation — record those under \`## Open questions\`.`;
    }
    if (state.mustGenerate) {
      return `${asked} No more rounds may be asked: write the card now — or the split if the request is ${SPLIT_WHEN}, or the stack if it is ${STACK_WHEN} — recording every default you took under \`## Open questions\`.`;
    }
    return `${asked} Ask the next round of questions only if something material is still unknown; otherwise write the card now — or propose the split, if the request is ${SPLIT_WHEN}, or the stack, if it is ${STACK_WHEN}.`;
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
  // Spec 223, #628, #752: the approved screens oldest first, then the kit's
  // snippets from the end, then the previous revision's frames are dropped
  // until the prompt fits its cap; the prompt says what was left out.
  return fitDesignPrompt(design, (fit) =>
    assembleWith(
      input,
      designSections(design, fit.snippets, fit.withFrames, fit.screens),
    ),
  );
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
          "The project's own Planner instructions. Where they speak about splitting plans or writing documents, they do not apply to a New work intake; everything they say about the project does.",
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
  sections.push(...inputSections(input), ...failureSections(input));
  return `${sections.join('\n\n')}\n`;
};

/**
 * #590 (ADR-0056): a discussion turn — the discussion instructions, the
 * project's own (as for an intake), the discuss contract, the skills chosen
 * at the start, what the discussion opened with and the person's latest
 * message. The plan session is resumed after the first turn, so the model
 * keeps the conversation; the opening is repeated so a turn that starts the
 * session late still has it.
 */
const assembleDiscuss = (input: PromptInput): string => {
  const skills = input.discussion?.skills ?? [];
  const sections = [
    DISCUSS_INSTRUCTIONS,
    ...(input.projectInstructions?.trim()
      ? [
          '# Project instructions',
          "The project's own Planner instructions. Where they speak about splitting plans or writing documents, they do not apply to a discussion; everything they say about the project does.",
          input.projectInstructions.trim(),
        ]
      : []),
    PLANNER_DISCUSS_CONTRACT.trim(),
    '# This turn',
    `Action: \`discuss\`. ${WHAT.discuss(input)}`,
    `Answer with exactly one \`${PLANNER_BLOCK_TAG}\` block whose \`action\` is \`discuss\`.`,
    '## Skills',
    skills.length > 0
      ? `Apply these installed skills to every answer: ${skills.map((s) => `\`${s}\``).join(', ')}. Use them to read and analyse only — never to change the repository.`
      : 'None.',
    '## The discussion opened with',
    fence('text', input.brief),
  ];
  if (input.input.message) {
    sections.push('## Message', fence('text', input.input.message));
  } else {
    sections.push('Answer the opening message above.');
  }
  sections.push(...failureSections(input));
  return `${sections.join('\n\n')}\n`;
};

const assembleWith = (input: PromptInput, design: string[]): string => {
  if (input.action === 'intake') return assembleIntake(input);
  if (input.action === 'discuss') return assembleDiscuss(input);
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
  sections.push(...inputSections(input), ...failureSections(input));
  return `${sections.join('\n\n')}\n`;
};
