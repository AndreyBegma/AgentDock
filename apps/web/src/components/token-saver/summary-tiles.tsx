import type { TokenSaverSummary } from '@agentdock/shared';
import { StatTile } from '@andrewbehma/glass-ui/stat-tile';
import { formatNumber } from '../../lib/format';
import {
  formatRate,
  formatSavedTokens,
  formatSavedUsd,
  keptShare,
} from '../../lib/token-saver/format';

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
        hint="Commands run with AGENTDOCK_RAW=1"
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
