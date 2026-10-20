import type { TokenSavedView } from '@nautelle/shared';
import { formatSavedTokens, savedLabel } from '../../lib/token-saver/format';

/**
 * `saved ≈ $0.41` next to a card's cost (#445 D13). The figure is the filter's
 * estimate, so it is always marked "≈"; the title carries the tokens behind it.
 * Renders nothing when the round saved nothing.
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
      title={`Token saver kept ${formatSavedTokens(saved.estimateTokens)} out of what the agent read (an estimate, bytes ÷ 4)`}
    >
      {label}
    </span>
  );
}
