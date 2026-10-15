import { planTaskKeySchema } from '../planner/types';
import { PLAN_TASK_FACE_TITLE_MAX } from './types';

/**
 * D6: a plan task's label on the board and in the List — `t3 · Onboarding v2`,
 * the plan title cut to `PLAN_TASK_FACE_TITLE_MAX` characters. A plan has no
 * per-project number, so the key and the plan title stand in for one.
 */
export const planTaskBoardLabel = (key: string, planTitle: string): string => {
  const title = planTitle.trim();
  const cut =
    title.length > PLAN_TASK_FACE_TITLE_MAX
      ? `${title.slice(0, PLAN_TASK_FACE_TITLE_MAX - 1).trimEnd()}…`
      : title;
  return cut ? `${key} · ${cut}` : key;
};

/** The board with a card's sheet open (`?card=<number>`). */
export const workCardHref = (projectId: string, number: number): string =>
  `/projects/${projectId}/board?card=${number}`;

/** D7: the board with a plan task's sheet open (`?plan=<planId>&task=<key>`). */
export const workPlanTaskHref = (
  projectId: string,
  planId: string,
  key: string,
): string =>
  `/projects/${projectId}/board?plan=${encodeURIComponent(planId)}&task=${encodeURIComponent(key)}`;

/**
 * D10: what `q` may name besides a title. Every present field is an
 * alternative (OR) to the title match; `text` is the trimmed query.
 */
export interface WorkSearch {
  text: string;
  /** `C-12` (any case) → 12. */
  cardNumber: number | null;
  /** `#12` → 12. */
  issueNumber: number | null;
  /** A string shaped like a task key (`t3`), lower-cased. */
  taskKey: string | null;
}

const positiveInt = (digits: string): number | null => {
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export const parseWorkSearch = (q: string): WorkSearch => {
  const text = q.trim();
  const card = /^c-(\d+)$/i.exec(text);
  const issue = /^#(\d+)$/.exec(text);
  const key = text.toLowerCase();
  return {
    text,
    cardNumber: card ? positiveInt(card[1]) : null,
    issueNumber: issue ? positiveInt(issue[1]) : null,
    taskKey: planTaskKeySchema.safeParse(key).success ? key : null,
  };
};
