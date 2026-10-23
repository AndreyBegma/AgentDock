import {
  type CreateReviewStepRequest,
  type InstalledSkillView,
  REVIEW_ERROR,
  REVIEW_STEP_NAME_MAX,
  REVIEW_STEPS_MAX,
  type ReviewErrorCode,
  type ReviewGenerationError,
  type ReviewStepView,
} from '@nautelle/shared';
import { ApiError } from '../api';

export const REVIEW_MASTER_LABEL = 'Review PRs before Finished';
export const REVIEW_MASTER_HINT =
  'After CI is green, each enabled step reviews the pull request; a card is Finished only when none finds a blocking problem.';
export const REVIEW_PUBLISH_LABEL = 'Publish findings as PR comments';
export const REVIEW_PUBLISH_HINT =
  'Findings are always kept in Nautelle. On, they are also posted on the pull request as comments.';

/** What each API refusal tells the person, with its fix. */
const REVIEW_ERROR_TEXT: Readonly<Record<ReviewErrorCode, string>> = {
  [REVIEW_ERROR.notFound]:
    'That review step no longer exists. Reload the page.',
  [REVIEW_ERROR.orderMismatch]:
    'The steps changed while you were reordering. Reload the page and try again.',
  [REVIEW_ERROR.builtinStep]:
    'Peer review is built in and cannot be deleted; turn it off instead.',
  [REVIEW_ERROR.wrongType]: 'That change does not apply to this kind of step.',
  [REVIEW_ERROR.unknownSkill]:
    'The project’s runner does not report that skill. Pick one from the list, or rescan the runner’s skills.',
  [REVIEW_ERROR.tooManySteps]: `A project has at most ${REVIEW_STEPS_MAX} review steps. Delete one first.`,
  [REVIEW_ERROR.noPeerReview]:
    'Turn review on first: that creates the Peer review step.',
  [REVIEW_ERROR.runnerOffline]:
    'The runner is offline, so the instructions could not be generated. Start it, then try again.',
  [REVIEW_ERROR.runnerUnsupported]:
    'The runner is too old to generate the instructions. Update it, then try again.',
  [REVIEW_ERROR.runnerNoAnswer]:
    'The runner did not answer in time. Try Regenerate again.',
  [REVIEW_ERROR.noModel]:
    'No default model is set, so the instructions could not be generated. An administrator sets one under Admin › AI providers.',
  [REVIEW_ERROR.generationEmpty]:
    'The model answered with nothing usable. Try Regenerate again.',
};

const isReviewErrorCode = (code: unknown): code is ReviewErrorCode =>
  typeof code === 'string' &&
  (Object.values(REVIEW_ERROR) as string[]).includes(code);

/** One inline line for a failed review request. */
export function describeReviewError(error: unknown): string {
  if (error instanceof ApiError) {
    const code: unknown = error.body?.error ?? error.code;
    if (isReviewErrorCode(code)) return REVIEW_ERROR_TEXT[code];
    if (error.status === 403)
      return 'Only project administrators can change review settings.';
    return error.message;
  }
  return 'Something went wrong. Try again.';
}

/** A generation that failed when review was just turned on: the step keeps the built-in default. */
export const generationErrorText = (error: ReviewGenerationError): string =>
  `Review is on, but the Peer review instructions could not be generated, so the built-in default is in use. ${
    isReviewErrorCode(error.code)
      ? REVIEW_ERROR_TEXT[error.code]
      : error.message
  } Use Regenerate to try again.`;

/** `ids` with the one at `from` moved to `to`; a move outside the list changes nothing. */
export function moveId(ids: readonly string[], from: number, to: number) {
  if (from === to || from < 0 || to < 0) return [...ids];
  if (from >= ids.length || to >= ids.length) return [...ids];
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** The steps in the order of `ids`; a step missing from `ids` keeps its place at the end. */
export function inOrder(
  steps: readonly ReviewStepView[],
  ids: readonly string[],
): ReviewStepView[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const ordered = ids.flatMap((id) => byId.get(id) ?? []);
  const rest = steps.filter((s) => !ids.includes(s.id));
  return [...ordered, ...rest];
}

/** What "Add step" sends, or null while the name or the skill is missing. */
export function newStepRequest(
  name: string,
  skillName: string | null,
): CreateReviewStepRequest | null {
  const trimmed = name.trim();
  if (!trimmed || !skillName) return null;
  return { name: trimmed.slice(0, REVIEW_STEP_NAME_MAX), skillName };
}

/** Skills a step can run: the runner's runnable ones, once each, by invocation. */
export function skillOptions(
  items: readonly InstalledSkillView[],
): { value: string; label: string }[] {
  const seen = new Set<string>();
  const options: { value: string; label: string }[] = [];
  for (const skill of items) {
    if (!skill.runnable || seen.has(skill.invocation)) continue;
    seen.add(skill.invocation);
    options.push({ value: skill.invocation, label: skill.invocation });
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}

/** The line under a step's name. */
export function stepSubtitle(step: ReviewStepView): string {
  if (step.type === 'skill') return `Skill ${step.skillName ?? ''}`.trim();
  return step.instructionsEditedAt
    ? 'Instructions generated from the repository, then edited'
    : step.instructionsGeneratedAt
      ? 'Instructions generated from the repository'
      : 'Built-in default instructions';
}

/** Regenerate's confirmation: it overwrites edits, so it says so. */
export const REGENERATE_COPY = {
  title: 'Regenerate the Peer review instructions?',
  consequence:
    'A model writes new instructions from the repository and replaces the current text. Any edits you made are lost and this cannot be undone.',
  verb: 'Regenerate',
} as const;
