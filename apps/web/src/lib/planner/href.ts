/**
 * Planner URLs. `planHref(…, key)` is the deep link `/tasks` rows use
 * (i172-web-tasks): it selects the plan and opens the task's panel.
 */
export const plannerHref = (projectId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/planner`;

export const planHref = (
  projectId: string,
  planId: string,
  taskKey?: string | null,
): string =>
  `${plannerHref(projectId)}/${encodeURIComponent(planId)}${
    taskKey ? `?task=${encodeURIComponent(taskKey)}` : ''
  }`;

/** The base path of every planner route of a plan; both ids are encoded (C-165). */
export const planApi = (projectId: string, planId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}`;

export const taskApi = (
  projectId: string,
  planId: string,
  key: string,
): string => `${planApi(projectId, planId)}/tasks/${encodeURIComponent(key)}`;
