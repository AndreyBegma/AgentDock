'use client';

import type { ProjectRuntimeProfile } from '@nautelle/shared';
import { api } from '../api';
import { useSection } from '../section/use-section';
import { skillRunProfiles } from '../skills/format';

/**
 * The runner's Claude profiles for a card's profile select (#322 D1). The
 * route is operator-only: with `enabled` off nothing is requested and the
 * list is empty. Codex profiles are dropped — a card runs on Claude only.
 */
export function useLaunchProfiles(projectId: string, enabled: boolean) {
  return useSection<ProjectRuntimeProfile[]>(
    () =>
      enabled
        ? api<ProjectRuntimeProfile[]>(
            `/projects/${projectId}/runtime-profiles`,
          ).then(skillRunProfiles)
        : Promise.resolve([]),
    [enabled, projectId],
  );
}
