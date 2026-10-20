import type { TokenSaverFilterSavings } from '@nautelle/shared';
import { formatNumber } from '../../lib/format';
import {
  filterLabel,
  formatSavedTokens,
  formatSavedUsd,
} from '../../lib/token-saver/format';

/**
 * The card sheet's per-filter breakdown of one round (#445 D13), most saved
 * first. Nothing when the round ran no filtered command.
 */
export function FilterBreakdown({
  filters,
}: {
  filters: readonly TokenSaverFilterSavings[] | undefined;
}) {
  if (!filters || filters.length === 0) return null;
  return (
    <section
      aria-label="Token saver, by filter"
      className="flex flex-col gap-1"
    >
      <h3 className="font-medium text-ink-2 text-xs uppercase tracking-wide">
        Token saver
      </h3>
      <ul className="flex flex-col divide-y divide-line text-sm">
        {filters.map((f) => (
          <li
            key={f.filter}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5"
          >
            <span className="min-w-0 break-words">{filterLabel(f.filter)}</span>
            <span className="num text-ink-2">
              {formatSavedUsd(f.estimateUsd) || '—'}
              <span className="text-ink-3">
                {' · '}
                {formatSavedTokens(f.estimateTokens)}
                {' · '}
                {formatNumber(f.commands, 0)}
                {f.commands === 1 ? ' command' : ' commands'}
                {f.bypassed > 0 ? ` · ${f.bypassed} raw` : ''}
                {f.passedThrough > 0 ? ` · ${f.passedThrough} unchanged` : ''}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
