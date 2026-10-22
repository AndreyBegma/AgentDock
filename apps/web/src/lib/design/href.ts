import { planApi } from '../planner/href';

/**
 * Design-stage URLs (spec 223 "API", "UI"). Every route sits under the
 * project; the mockup itself is the revision's `htmlUrl`.
 */

/** The viewer, with its URL state when given (`viewerSearch`). */
export const designHref = (
  projectId: string,
  planId: string,
  taskKey: string,
  search = '',
): string =>
  `/projects/${encodeURIComponent(projectId)}/planner/${encodeURIComponent(
    planId,
  )}/tasks/${encodeURIComponent(taskKey)}/design${search}`;

/** A task's design: GET / PATCH, and `/generate|/comments|/revise|/approve`. */
export const designApi = (
  projectId: string,
  planId: string,
  taskKey: string,
): string =>
  `${planApi(projectId, planId)}/tasks/${encodeURIComponent(taskKey)}/design`;

/**
 * A board card's design (#243, ADR-0025): the same routes as a task's, under
 * the card's per-project number.
 */
export const cardDesignApi = (projectId: string, number: number): string =>
  `/projects/${encodeURIComponent(projectId)}/board/cards/${number}/design`;

/** The card's design viewer, with its URL state when given (`viewerSearch`). */
export const cardDesignHref = (
  projectId: string,
  number: number,
  search = '',
): string =>
  `/projects/${encodeURIComponent(projectId)}/board/cards/${number}/design${search}`;

/** The project's UI profile: GET / PUT, and `/versions`, `/rebuild`. */
export const uiProfileApi = (projectId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/ui-profile`;

export const designSettingsApi = (projectId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/design-settings`;

/**
 * The profile's style kit and snippets as one page, served with the mockup's
 * headers; the iframe's `src`, so it goes through the `/api` rewrite.
 */
export const uiProfilePreviewSrc = (
  projectId: string,
  version: number,
): string =>
  `/api${uiProfileApi(projectId)}/preview?version=${encodeURIComponent(
    String(version),
  )}`;

/** A profile build's run, beside the Runs tab of the project's Activity. */
export { runHref } from '../history/format';

/** The project's installed skills (#24): the choices for design skills. */
export const installedSkillsApi = (projectId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/skills`;

/** #480: a stack's shared design — the same routes as a card's, at its number. */
export const stackDesignApi = (projectId: string, number: number): string =>
  `/projects/${encodeURIComponent(projectId)}/board/stacks/${number}/design`;

/** #480: the stack's design viewer. */
export const stackDesignHref = (
  projectId: string,
  number: number,
  search = '',
): string =>
  `/projects/${encodeURIComponent(projectId)}/board/stacks/${number}/design${search}`;
