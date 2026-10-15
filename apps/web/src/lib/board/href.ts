/** The board with a card's sheet open (`?card=<number>`). */
export const boardCardHref = (projectId: string, number: number): string =>
  `/projects/${projectId}/board?card=${number}`;
