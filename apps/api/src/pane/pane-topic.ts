import { type LiveTopic, parseLiveTopic } from '@agentdock/shared';

export interface PaneTarget {
  projectId: string;
  slot: string;
}

/**
 * The project and slot of a `pane:` topic id (`<projectId>:<slot>`). The
 * topic schema already pinned both parts, neither holding a `:`.
 */
export const parsePaneId = (id: string): PaneTarget => {
  const colon = id.indexOf(':');
  return { projectId: id.slice(0, colon), slot: id.slice(colon + 1) };
};

/** The project and slot of a `pane:<projectId>:<slot>` topic. */
export const parsePaneTopic = (topic: LiveTopic): PaneTarget =>
  parsePaneId(parseLiveTopic(topic).id ?? '');
