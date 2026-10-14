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
  `/projects/${projectId}/planner/${planId}/tasks/${encodeURIComponent(
    taskKey,
  )}/design${search}`;

/** A task's design: GET / PATCH, and `/generate|/comments|/revise|/approve`. */
export const designApi = (
  projectId: string,
  planId: string,
  taskKey: string,
): string =>
  `${planApi(projectId, planId)}/tasks/${encodeURIComponent(taskKey)}/design`;

/** The project's UI profile: GET / PUT, and `/versions`, `/rebuild`. */
export const uiProfileApi = (projectId: string): string =>
  `/projects/${projectId}/ui-profile`;

export const designSettingsApi = (projectId: string): string =>
  `/projects/${projectId}/design-settings`;

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

/** The project's installed skills (#24): the choices for design skills. */
export const installedSkillsApi = (projectId: string): string =>
  `/projects/${projectId}/skills`;
