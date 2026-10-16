export const boardHref = (projectId: string): string =>
  `/projects/${projectId}/board`;

/** The board with a card's sheet open (`?card=<number>`). */
export const boardCardHref = (projectId: string, number: number): string =>
  `${boardHref(projectId)}?card=${number}`;

/** #431: one card on its own page. */
export const boardCardPageHref = (projectId: string, number: number): string =>
  `${boardHref(projectId)}/cards/${number}`;

/**
 * #409: the board with New work open; `brief` prefills What to do (the
 * Fleet canvas's "Plan this", #160). The Board still reads the older
 * `?newPlan=1` the same way.
 */
export const boardNewWorkHref = (projectId: string, brief?: string): string =>
  `${boardHref(projectId)}?newWork=1${
    brief ? `&brief=${encodeURIComponent(brief)}` : ''
  }`;

/**
 * #337 D7's New Plan link, kept for its callers: New Plan is gone (#409), so
 * it opens New work.
 */
export const boardNewPlanHref = boardNewWorkHref;

/** #480: one stack on its own page. */
export const boardStackPageHref = (projectId: string, number: number): string =>
  `${boardHref(projectId)}/stacks/${number}`;
