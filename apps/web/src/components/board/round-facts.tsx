'use client';

import { Disclosure } from '@andrewbehma/glass-ui/disclosure';
import type { CardRoundView } from '@nautelle/shared';
import { useState } from 'react';
import {
  type RoundFact,
  roundFacts,
  roundSavedText,
  summaryNeedsClamp,
} from '../../lib/board/round-facts';
import { FilterBreakdown } from '../token-saver/filter-breakdown';

function FactValue({ fact }: { fact: RoundFact }) {
  const className = fact.mono ? 'tabular-nums' : undefined;
  return fact.href ? (
    <a
      href={fact.href}
      target="_blank"
      rel="noreferrer"
      className={`${className ?? ''} underline-offset-2 hover:underline`}
    >
      {fact.value}
    </a>
  ) : (
    <span className={className}>{fact.value}</span>
  );
}

/** A round's run facts as a compact, wrapping list; null facts are left out. */
export function RoundFacts({
  round,
  now,
}: {
  round: CardRoundView;
  now: number;
}) {
  const facts = roundFacts(round, now);
  if (facts.length === 0) return null;
  return (
    <dl
      aria-label="Round facts"
      className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs"
    >
      {facts.map((fact) => (
        <div key={fact.key} className="flex gap-1">
          <dt className="text-ink-3">{fact.label}</dt>
          <dd>
            <FactValue fact={fact} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The agent summary, clamped to a few lines until "Show all" (C-332). */
export function RoundSummary({
  text,
  defaultExpanded = false,
}: {
  text: string;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const clamp = summaryNeedsClamp(text);
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span
        className={`whitespace-pre-wrap break-words${
          clamp && !expanded ? ' line-clamp-4' : ''
        }`}
      >
        {text}
      </span>
      {clamp ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="text-accent-ink underline underline-offset-2"
        >
          {expanded ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </div>
  );
}

/** The per-filter breakdown, folded behind the one-line token total. */
export function RoundTokenSaver({
  round,
  defaultOpen = false,
}: {
  round: CardRoundView;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const filters = round.tokenSaverFilters;
  if (!filters || filters.length === 0) return null;
  return (
    <Disclosure
      open={open}
      onOpenChange={setOpen}
      trigger={
        roundSavedText(round) ?? `Token saver · ${filters.length} filters`
      }
      triggerClassName="text-xs text-accent-ink underline underline-offset-2"
    >
      <FilterBreakdown filters={filters} />
    </Disclosure>
  );
}
