'use client';

import type { ProjectRuleCandidateView } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { useId } from 'react';
import {
  candidateSelectionSummary,
  initialCandidateSelection,
} from '../../../lib/project-rules/format';

/**
 * Coding-rule candidates a scan found (#584), each a checkbox with the file
 * it came from. A candidate already on the project is shown but cannot be
 * checked. Used by the connect dialog and the Rules screen's rescan.
 */
export function RuleCandidateList({
  candidates,
  selected,
  onChange,
  disabled = false,
  title = 'Coding rules found',
}: {
  candidates: readonly ProjectRuleCandidateView[];
  selected: ReadonlySet<number>;
  onChange: (next: Set<number>) => void;
  disabled?: boolean;
  title?: string;
}) {
  const headingId = useId();
  const toggle = (index: number, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(index);
    else next.delete(index);
    onChange(next);
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          {title}{' '}
          <span className="font-normal text-ink-2">
            · {candidateSelectionSummary(candidates, selected)}
          </span>
        </h3>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onChange(initialCandidateSelection(candidates))}
          >
            Select all
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onChange(new Set())}
          >
            None
          </Button>
        </div>
      </div>
      <ul
        aria-labelledby={headingId}
        className="flex max-h-72 flex-col gap-2 overflow-y-auto"
      >
        {candidates.map((candidate, index) => (
          <li
            key={`${candidate.source}:${candidate.title}`}
            className="flex items-start justify-between gap-3"
          >
            <Checkbox
              id={`${headingId}-${index}`}
              checked={!candidate.duplicate && selected.has(index)}
              disabled={disabled || candidate.duplicate}
              onChange={(e) => toggle(index, e.target.checked)}
              description={
                candidate.duplicate ? (
                  <span className="text-xs text-ink-3">Already a rule</span>
                ) : candidate.description ? (
                  <span className="line-clamp-2 text-xs text-ink-2">
                    {candidate.description}
                  </span>
                ) : undefined
              }
            >
              <span className="font-medium">{candidate.title}</span>
            </Checkbox>
            <Badge label={candidate.source} />
          </li>
        ))}
      </ul>
    </section>
  );
}
