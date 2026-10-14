'use client';

import type { TaskDesignView } from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Spinner } from '@andrewbehma/glass-ui/spinner';

/**
 * What the person must not mistake the mockup for (spec 223 D5, "UI"), and
 * the design's live state: a turn drawing, skills skipped (D15).
 */
export function MockupBanner({ design }: { design: TaskDesignView }) {
  const working =
    design.activeTurnId !== null ||
    design.status === 'generating' ||
    design.status === 'revising';
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <Banner tone="info">
        Mockup — the implementation uses the project’s real components.
      </Banner>
      {working ? (
        <Banner tone="info" icon={<Spinner size="sm" label={null} />}>
          {design.status === 'revising'
            ? 'The planner is revising the mockup with the open comments…'
            : 'The planner is drawing the mockup…'}
        </Banner>
      ) : null}
      {design.warnings.map((w) => (
        <Banner key={w.skill} tone="warn" title={`Skill ${w.skill} skipped`}>
          {w.message}
        </Banner>
      ))}
    </div>
  );
}
