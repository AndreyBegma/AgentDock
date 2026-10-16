import type { DesignFrameView } from '@agentdock/shared';

/**
 * #441: where a frame is published on approve, relative to the design's
 * folder — the card's spec folder, or the plan task's — as the viewer names
 * it: `design/<variant>/<frame slug>.html`.
 */
export const framePath = (
  variant: number,
  frame: Pick<DesignFrameView, 'slug'>,
): string => `design/${variant}/${frame.slug}.html`;
