export const boardHref = (projectId: string): string =>
  `/projects/${projectId}/board`;

/** The board with a card's sheet open (`?card=<number>`). */
export const boardCardHref = (projectId: string, number: number): string =>
  `${boardHref(projectId)}?card=${number}`;

/**
 * #337 D7: the board with the New Plan panel open; `brief` prefills it (the
 * Fleet canvas's "Plan this", #160).
 */
export const boardNewPlanHref = (projectId: string, brief?: string): string =>
  `${boardHref(projectId)}?newPlan=1${
    brief ? `&brief=${encodeURIComponent(brief)}` : ''
  }`;
