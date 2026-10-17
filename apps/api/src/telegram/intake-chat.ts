import {
  cardLabel,
  type PlanAnswer,
  type PlanCandidateView,
  type PlanDetail,
  type PlanIntakeSplitView,
  type PlanQuestion,
  type PlanTaskKind,
} from '@agentdock/shared';
import { callbackCodec } from './callback-data';
import { appLink, escapeLinkUrl, escapeMarkdownV2 } from './markdown-v2';
import type { InlineKeyboardButton } from './telegram-client';

/**
 * #574: the New work intake in a Telegram chat — where a plan stands, and
 * the messages and buttons the bot shows for it. Pure:
 * `TelegramIntakeService` does the checks, the planner calls and the sends.
 * Spec 22 D10: only the questions, their options and recommendations, and
 * the cards' titles and summaries leave AgentDock — never the brief, the
 * prompt, a turn's error or its raw output.
 */

/** Where an intake stands, as the web's `intakePhase` reads it. */
export type IntakeChatPhase =
  | { kind: 'thinking'; turnId: string }
  | { kind: 'failed'; turnId: string }
  | { kind: 'round'; turnId: string; round: number; maxRounds: number }
  | { kind: 'split'; split: PlanIntakeSplitView }
  | { kind: 'review'; candidates: PlanCandidateView[] }
  | { kind: 'done' }
  | { kind: 'closed' }
  | { kind: 'idle'; turnId: string | null };

export const intakeChatPhase = (plan: PlanDetail): IntakeChatPhase => {
  if (plan.status === 'done') return { kind: 'done' };
  // #592 (ADR-0055): the cards wait in Drafts as candidates.
  if (plan.status === 'reviewing') {
    return { kind: 'review', candidates: plan.intake?.candidates ?? [] };
  }
  if (plan.status === 'archived' || plan.status === 'sent') {
    return { kind: 'closed' };
  }
  if (plan.activeTurnId) return { kind: 'thinking', turnId: plan.activeTurnId };
  const last = plan.turns.filter((t) => t.taskKey === null).at(-1) ?? null;
  if (last?.phase === 'failed') return { kind: 'failed', turnId: last.id };
  if (plan.questions.length > 0) {
    const asked = Math.max(plan.intake?.roundsAsked ?? 1, 1);
    return {
      kind: 'round',
      turnId: last?.id ?? '',
      round: asked,
      maxRounds: plan.intake?.maxRounds ?? asked,
    };
  }
  if (plan.intake?.split) return { kind: 'split', split: plan.intake.split };
  return { kind: 'idle', turnId: last?.id ?? null };
};

/** What the chat last showed for a phase: a phase shown once is not shown again. */
export const phaseKey = (phase: IntakeChatPhase): string => {
  switch (phase.kind) {
    case 'split':
      return `split:${phase.split.turnId}`;
    case 'review':
    case 'done':
    case 'closed':
      return phase.kind;
    case 'idle':
      return `idle:${phase.turnId ?? ''}`;
    default:
      return `${phase.kind}:${phase.turnId}`;
  }
};

// ─── Buttons ─────────────────────────────────────────────────────────────────

/** `no:<plan>:<option index>`: an option of the question message it is on. */
export const INTAKE_OPTION = callbackCodec('no', { plan: 'id', option: 'int' });
/** `nd:<plan>`: Done on a multiple-choice question message. */
export const INTAKE_DONE = callbackCodec('nd', { plan: 'id' });

export const INTAKE_ACTIONS = [
  'send',
  'generate',
  'keep_one',
  'create_all',
  'retry',
  'discard',
] as const;
export type IntakeAction = (typeof INTAKE_ACTIONS)[number];

/** `na:<plan>:<action>`: a button of the round, proposal or failure message. */
export const INTAKE_ACTION = callbackCodec('na', {
  plan: 'id',
  action: 'word',
});

export const isIntakeAction = (word: string): word is IntakeAction =>
  (INTAKE_ACTIONS as readonly string[]).includes(word);

const LABEL_MAX = 60;
const QUESTION_MAX = 1500;
const WHY_MAX = 400;
const SUMMARY_MAX = 300;
const TITLE_MAX = 200;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const action = (
  planId: string,
  text: string,
  act: IntakeAction,
): InlineKeyboardButton => ({
  text,
  callback_data: INTAKE_ACTION.encode({ plan: planId, action: act }),
});

/** An answer as the chat collects it, before the round is sent. */
export interface ChatAnswer {
  optionId?: string;
  optionIds?: string[];
  text?: string;
}

export type ChatAnswers = Record<string, ChatAnswer>;

/** The options picked on a question so far. */
export const pickedOf = (answer: ChatAnswer | undefined): string[] =>
  answer?.optionIds ?? (answer?.optionId ? [answer.optionId] : []);

/**
 * A press on option `index`: a single-choice question takes it, a
 * multiple-choice one toggles it, in the question's option order. Picking
 * drops an own answer typed before, as the option replaces it.
 */
export const pressOption = (
  answers: ChatAnswers,
  question: PlanQuestion,
  index: number,
): ChatAnswers | null => {
  const option = question.options[index];
  if (!option) return null;
  if (question.multiple !== true) {
    return { ...answers, [question.id]: { optionId: option.id } };
  }
  const picked = new Set(pickedOf(answers[question.id]));
  if (picked.has(option.id)) picked.delete(option.id);
  else picked.add(option.id);
  const optionIds = question.options
    .map((o) => o.id)
    .filter((id) => picked.has(id));
  const { [question.id]: _gone, ...rest } = answers;
  return optionIds.length > 0
    ? { ...rest, [question.id]: { optionIds } }
    : rest;
};

/** The chat's answers as a turn's, in the round's order. */
export const chatAnswers = (
  questions: readonly PlanQuestion[],
  answers: ChatAnswers,
): PlanAnswer[] =>
  questions.flatMap((q): PlanAnswer[] => {
    const a = answers[q.id];
    if (!a) return [];
    if (a.text) return [{ questionId: q.id, text: a.text }];
    if (a.optionIds?.length) {
      return [{ questionId: q.id, optionIds: a.optionIds }];
    }
    if (a.optionId) return [{ questionId: q.id, optionId: a.optionId }];
    return [];
  });

/** One button per option — ✓ on the picked ones — and Done for a multiple. */
export const questionKeyboard = (
  planId: string,
  question: PlanQuestion,
  answer: ChatAnswer | undefined,
): InlineKeyboardButton[][] => {
  const picked = new Set(pickedOf(answer));
  const recommended = question.recommendation.optionId;
  const rows = question.options.map((option, index) => [
    {
      text: clip(
        `${picked.has(option.id) ? '✓ ' : ''}${option.label}${
          option.id === recommended ? ' ★' : ''
        }`,
        LABEL_MAX,
      ),
      callback_data: INTAKE_OPTION.encode({ plan: planId, option: index }),
    },
  ]);
  return question.multiple === true
    ? [
        ...rows,
        [
          {
            text: 'Done',
            callback_data: INTAKE_DONE.encode({ plan: planId }),
          },
        ],
      ]
    : rows;
};

/**
 * A question as its own message (MarkdownV2): its title, the question, the
 * recommendation with its why, and how to answer — and, once answered, the
 * answer given.
 */
export const questionText = (
  question: PlanQuestion,
  position: { index: number; total: number },
  answer: ChatAnswer | undefined,
  done = false,
): string => {
  const rec = question.recommendation;
  const picked = pickedOf(answer)
    .map((id) => question.options.find((o) => o.id === id)?.label)
    .filter((label): label is string => !!label);
  const given = answer?.text
    ? `Your answer: ${clip(answer.text, WHY_MAX)}`
    : picked.length > 0
      ? `Picked: ${picked.join(', ')}`
      : null;
  const how =
    question.multiple === true
      ? 'Pick one or more options, then Done — or reply to this message with your own answer.'
      : question.options.length > 0
        ? 'Pick an option, or reply to this message with your own answer.'
        : 'Reply to this message with your answer.';
  return [
    `*${escapeMarkdownV2(
      `${position.index + 1}/${position.total} · ${clip(question.title, TITLE_MAX)}`,
    )}*`,
    escapeMarkdownV2(clip(question.question, QUESTION_MAX)),
    `_${escapeMarkdownV2(`Recommended: ${clip(rec.text, WHY_MAX)}`)}_ ${escapeMarkdownV2(
      `— ${clip(rec.why, WHY_MAX)}`,
    )}`,
    ...(given ? [escapeMarkdownV2(given)] : []),
    ...(done && given ? [] : [escapeMarkdownV2(how)]),
  ].join('\n');
};

/** The line the thinking message becomes once a round is open. */
export const roundHeader = (round: number, maxRounds: number, count: number) =>
  escapeMarkdownV2(
    `Round ${round} of ${maxRounds}: ${count} question${count === 1 ? '' : 's'}.`,
  );

/** The message under a round's questions: Send answers, Enough — generate. */
export const roundControls = (planId: string) => ({
  text: escapeMarkdownV2(
    'Answer the questions above, then Send answers. Unanswered questions take the recommendation (★). Enough — generate writes the card now.',
  ),
  keyboard: [
    [
      action(planId, 'Send answers', 'send'),
      action(planId, 'Enough — generate', 'generate'),
    ],
    [action(planId, 'Discard', 'discard')],
  ],
});

export const THINKING_TEXT = escapeMarkdownV2('Thinking…');

const openInApp = (
  appUrl: string | null,
  projectId: string,
  planId: string,
) => {
  const url = appLink(
    appUrl,
    `/projects/${projectId}/board?intake=${encodeURIComponent(planId)}`,
  );
  return url
    ? [`[${escapeMarkdownV2('Open in app')}](${escapeLinkUrl(url)})`]
    : [];
};

const cardLine = (card: {
  title: string;
  kind: PlanTaskKind;
  summary: string;
}) =>
  escapeMarkdownV2(
    `• ${clip(card.title, TITLE_MAX)} (${card.kind}) — ${clip(card.summary, SUMMARY_MAX)}`,
  );

/**
 * A split or stack proposal: the cards with their summaries — by stage for
 * a stack — and Create all, Keep one card, Discard. Not the reason the model
 * gave, nor the stack's body: they are its prose (D10).
 */
export const splitMessage = (
  split: PlanIntakeSplitView,
  ids: { planId: string; projectId: string },
  appUrl: string | null,
) => {
  const byIndex = new Map(split.cards.map((c) => [c.index, c]));
  const stack = split.stack;
  const body = stack
    ? [
        `*${escapeMarkdownV2(
          `A stack of ${split.cards.length} cards: ${clip(stack.title, TITLE_MAX)}`,
        )}*`,
        ...stack.stages.flatMap((stage, i) => [
          `_${escapeMarkdownV2(`Stage ${i + 1}: ${clip(stage.title, TITLE_MAX)}`)}_`,
          ...stage.cards.flatMap((index) => {
            const card = byIndex.get(index);
            return card ? [cardLine(card)] : [];
          }),
        ]),
      ]
    : [
        `*${escapeMarkdownV2(`${split.cards.length} cards proposed`)}*`,
        ...split.cards.map(cardLine),
      ];
  return {
    text: [
      ...body,
      escapeMarkdownV2(
        stack
          ? 'Create all sends the stack’s cards to Drafts, where you accept them.'
          : 'Create all sends every card to Drafts, where you accept them.',
      ),
      ...openInApp(appUrl, ids.projectId, ids.planId),
    ].join('\n'),
    keyboard: [
      [
        action(ids.planId, 'Create all', 'create_all'),
        action(ids.planId, 'Keep one card', 'keep_one'),
      ],
      [action(ids.planId, 'Discard', 'discard')],
    ],
  };
};

/** A failed turn: fixed words, never the turn's error (D10). */
export const failedMessage = (planId: string) => ({
  text: escapeMarkdownV2(
    'The planner turn failed. Retry it, or Cancel to discard this intake.',
  ),
  keyboard: [
    [action(planId, 'Retry', 'retry'), action(planId, 'Cancel', 'discard')],
  ],
});

/** Nothing open and nothing running: only Enough — generate moves it on. */
export const idleMessage = (planId: string) => ({
  text: escapeMarkdownV2('Nothing is open. Generate the card now?'),
  keyboard: [
    [
      action(planId, 'Enough — generate', 'generate'),
      action(planId, 'Discard', 'discard'),
    ],
  ],
});

/** The cards the intake made, each with its kind and a link to it. */
export const cardsMessage = (
  cards: { number: number; title: string; kind: PlanTaskKind }[],
  projectId: string,
  appUrl: string | null,
): string =>
  [
    `*${escapeMarkdownV2(
      cards.length === 1 ? 'Card created' : `${cards.length} cards created`,
    )}*`,
    ...cards.map((card) => {
      const line = escapeMarkdownV2(
        `${cardLabel(card.number)} ${clip(card.title, TITLE_MAX)} · ${card.kind}`,
      );
      const url = appLink(
        appUrl,
        `/projects/${projectId}/board?card=${card.number}`,
      );
      return url ? `[${line}](${escapeLinkUrl(url)})` : line;
    }),
  ].join('\n');

/**
 * #592 (ADR-0055): the intake wrote candidates — no card exists until the
 * person accepts them in Drafts on the Board.
 */
export const candidatesMessage = (
  candidates: readonly Pick<PlanCandidateView, 'title' | 'kind'>[],
  projectId: string,
  appUrl: string | null,
): string => {
  const url = appLink(appUrl, `/projects/${projectId}/board`);
  const where = escapeMarkdownV2(
    'Accept or reject them in Drafts on the Board.',
  );
  return [
    `*${escapeMarkdownV2(
      candidates.length === 1
        ? 'A card waits for you'
        : `${candidates.length} cards wait for you`,
    )}*`,
    ...candidates.map((c) =>
      escapeMarkdownV2(`${clip(c.title, TITLE_MAX)} · ${c.kind}`),
    ),
    url ? `[${where}](${escapeLinkUrl(url)})` : where,
  ].join('\n');
};

export const CLOSED_TEXT = escapeMarkdownV2(
  'This intake is discarded; no card was made.',
);
