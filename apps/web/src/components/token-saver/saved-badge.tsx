import type { TokenSavedView } from '@nautelle/shared';
import {
  formatSavedTokens,
  SAVED_PRICING_NOTE,
  savedLabel,
} from '../../lib/token-saver/format';

/**
 * `saved ≈ 42k tok · $0.13` next to a card's cost (#746 D7, amending #445
 * D13). The figure is the filter's estimate, so it is always marked "≈"; the
 * title says how the dollars are priced. Renders nothing when the round saved
 * nothing.
 */
export function SavedBadge({
  saved,
  className,
}: {
  saved: TokenSavedView | null | undefined;
  className?: string;
}) {
  const label = savedLabel(saved);
  if (!label || !saved) return null;
  return (
    <span
      className={`num whitespace-nowrap text-ok ${className ?? ''}`}
      title={`Token saver kept ${formatSavedTokens(saved.estimateTokens)} out of what the agent read (${SAVED_PRICING_NOTE})`}
    >
      {label}
    </span>
  );
}
