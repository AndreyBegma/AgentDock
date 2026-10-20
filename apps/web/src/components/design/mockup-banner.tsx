'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import type { TaskDesignView } from '@nautelle/shared';

/**
 * What the person must not mistake the mockup for (spec 223 D5, "UI"), and
 * the skills skipped (D15). The running state is `DesignProgress` (#275 D7).
 */
export function MockupBanner({ design }: { design: TaskDesignView }) {
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <Banner tone="info">
        Mockup — the implementation uses the project’s real components.
      </Banner>
      {design.warnings.map((w) => (
        <Banner key={w.skill} tone="warn" title={`Skill ${w.skill} skipped`}>
          {w.message}
        </Banner>
      ))}
    </div>
  );
}
