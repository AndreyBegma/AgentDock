import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WatchedProject } from '@agentdock/shared/protocol';
import { CommandFailure } from '../failure';

/** The watched project a queue command names; anything else is refused (spec 10 D10). */
export const watchedById = (
  projectId: string,
  watched: readonly WatchedProject[],
): WatchedProject => {
  const project = watched.find((p) => p.id === projectId);
  if (!project) {
    throw new CommandFailure(
      'path_not_allowed',
      `${projectId} is not a watched project of this runner`,
    );
  }
  return project;
};

/** `orchestrator.readyLabel` from the project's `.code-analyzer-config.json`, if set. */
export const readyLabelOf = (root: string): string | null => {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(root, '.code-analyzer-config.json'), 'utf8'),
    );
    const label = (raw as { orchestrator?: { readyLabel?: unknown } })
      ?.orchestrator?.readyLabel;
    return typeof label === 'string' && label.length > 0 ? label : null;
  } catch {
    return null;
  }
};
