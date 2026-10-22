'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Select } from '@andrewbehma/glass-ui/select';
import type { DesignTemplate, DesignTemplateChoice } from '@nautelle/shared';
import { useId } from 'react';
import { api } from '../../lib/api';
import { designTemplatesApi } from '../../lib/design/href';
import { templateOptions } from '../../lib/design/templates';
import { useSection } from '../../lib/section/use-section';

/**
 * #833 D8: the design template of a card, a plan task or a stack — a select
 * of the project's templates with an "auto" tag while the model chose it. A
 * project's list that does not load leaves the three built-ins.
 */
export function TemplateSelect({
  projectId,
  value,
  source,
  disabled,
  onChange,
}: {
  projectId: string;
  /** The template in effect; null before the normalizer has chosen one. */
  value: string | null;
  source?: DesignTemplateChoice;
  disabled?: boolean;
  onChange: (key: string) => void;
}) {
  const labelId = useId();
  const loaded = useSection(
    () => api<DesignTemplate[]>(designTemplatesApi(projectId)),
    [projectId],
  );
  const options = templateOptions(
    Array.isArray(loaded.data) ? loaded.data : null,
  );
  // A key the list no longer has (a deleted custom template) stays visible.
  const known = value === null || options.some((o) => o.key === value);
  return (
    <div className="flex items-center gap-2">
      <span id={labelId} className="text-xs text-ink-3">
        Template
      </span>
      <Select
        aria-labelledby={labelId}
        className="w-36"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {value === null ? (
          <option value="" disabled>
            Not chosen
          </option>
        ) : null}
        {known ? null : <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.name}
          </option>
        ))}
      </Select>
      {source === 'auto' ? <Badge label="auto" /> : null}
    </div>
  );
}
