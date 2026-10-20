import { StatTile } from '@andrewbehma/glass-ui/stat-tile';
import type { TokenSaverSummary } from '@nautelle/shared';
import { formatNumber, formatTokens } from '../../lib/format';
import {
  cacheReadShare,
  formatRate,
  formatSavedTokens,
  formatSavedUsd,
  inputTokensPerRun,
  keptShare,
} from '../../lib/token-saver/format';
import { promptCacheTotals } from '../../lib/token-saver/summary';

/** The period's four figures (Usage and the dashboard share them, D13). */
export function SummaryTiles({ summary }: { summary: TokenSaverSummary }) {
  const { totals } = summary;
  const none = totals.commands === 0;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        hue={4}
        label="Saved (estimate)"
        value={none ? '—' : formatSavedUsd(totals.estimateUsd) || '—'}
        hint={
          none
            ? 'No filtered command in this range'
            : `${formatSavedTokens(totals.estimateTokens)} · agents read ${formatRate(keptShare(totals.rawBytes, totals.keptBytes))} of the original`
        }
      />
      <StatTile
        hue={1}
        label="Filtered commands"
        value={formatNumber(totals.commands, 0)}
      />
      <StatTile
        hue={7}
        label="Bypass rate"
        value={none ? '—' : formatRate(summary.bypassRate)}
        hint="Commands run with NAUTELLE_RAW=1"
      />
      <StatTile
        hue={5}
        label="Returned the original"
        value={none ? '—' : formatRate(summary.passThroughRate)}
        hint="Output no filter could safely shorten"
      />
    </div>
  );
}

/**
 * #648: the measured prompt cache of the period's ended runs — the share of
 * input read from the cache and input tokens per run, from usage records, not
 * the filter's estimate.
 */
export function PromptCacheTile({ summary }: { summary: TokenSaverSummary }) {
  const totals = promptCacheTotals(summary.promptCache);
  const none = totals.runs === 0;
  return (
    <StatTile
      hue={3}
      label="Prompt cache read share"
      value={none ? '—' : formatRate(cacheReadShare(totals))}
      hint={
        none
          ? 'No ended run with usage in this range'
          : `${formatTokens(inputTokensPerRun(totals))} input tokens per run · ${formatNumber(totals.runs, 0)} runs, measured`
      }
    />
  );
}
