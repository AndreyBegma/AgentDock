'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { OVERLAY_PART_RULES, type PrefixOverlayView } from '@nautelle/shared';
import { useCallback, useEffect, useState } from 'react';
import { OverlayReview } from '../../../../../../components/token-saver/overlay-review';
import { formatNumber } from '../../../../../../lib/format';
import { Time } from '../../../../../../lib/format/time';
import {
  fetchPrefixOverlays,
  OVERLAY_STATE_LABEL,
  OVERLAY_STATE_TONE,
  sizeChange,
} from '../../../../../../lib/token-saver/prefix';

const BADGE_TONE = {
  neutral: 'neutral',
  success: 'ok',
  warning: 'warn',
  danger: 'danger',
} as const;

/**
 * #751 B6 "UI": the compressed injected rules of this project — the newest
 * `rules` overlay, its state and size, and for an admin the diff to review.
 * Nothing shows until a Haiku compression has been made. A rules change makes
 * a new proposal, and an older approved one stays in use until it is decided.
 */
export function CompressedRulesPanel({
  projectId,
  isAdmin,
  version,
}: {
  projectId: string;
  isAdmin: boolean;
  /** Changes when the rules do, so the panel reads again. */
  version: string;
}) {
  const [overlay, setOverlay] = useState<PrefixOverlayView | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const closeReview = useCallback(() => setReviewing(null), []);

  const load = useCallback(() => {
    fetchPrefixOverlays(projectId)
      .then((list) =>
        // Newest first: a proposal to decide wins over an older decision.
        setOverlay(
          list.find(
            (o) => o.part === OVERLAY_PART_RULES && o.state === 'proposed',
          ) ??
            list.find((o) => o.part === OVERLAY_PART_RULES) ??
            null,
        ),
      )
      .catch(() => setOverlay(null));
  }, [projectId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the trigger
  useEffect(() => {
    load();
  }, [load, version]);

  if (!overlay) return null;
  const { percent } = sizeChange(
    overlay.originalEstTokens,
    overlay.contentEstTokens,
  );

  return (
    <Card pad="lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">Compressed rules</span>
            <Badge
              size="md"
              tone={BADGE_TONE[OVERLAY_STATE_TONE[overlay.state]]}
              label={OVERLAY_STATE_LABEL[overlay.state]}
            />
          </div>
          <p className="text-ink-3 text-xs">
            Haiku shortened the enabled rules: ≈{' '}
            {formatNumber(overlay.originalEstTokens, 0)} → ≈{' '}
            {formatNumber(overlay.contentEstTokens, 0)} tokens (
            {percent > 0 ? '+' : percent < 0 ? '−' : ''}
            {Math.abs(percent)}%), made <Time value={overlay.createdAt} />. Once
            approved they replace the originals in the Token saver test arm; the
            rules above are never changed.
          </p>
        </div>
        {isAdmin ? (
          <Button size="sm" onClick={() => setReviewing(overlay.id)}>
            {overlay.state === 'proposed' ? 'Review' : 'View diff'}
          </Button>
        ) : null}
      </div>
      {isAdmin ? (
        <OverlayReview
          projectId={projectId}
          overlayId={reviewing}
          onClose={closeReview}
          onDecided={load}
        />
      ) : null}
    </Card>
  );
}
