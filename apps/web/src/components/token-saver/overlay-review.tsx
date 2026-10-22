'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import type {
  PrefixOverlayDetailView,
  PrefixOverlayView,
} from '@nautelle/shared';
import { useEffect, useMemo, useState } from 'react';
import { formatNumber } from '../../lib/format';
import { useErrorToast } from '../../lib/section/use-error-toast';
import {
  approvePrefixOverlay,
  describePrefixError,
  fetchPrefixOverlay,
  lineDiff,
  OVERLAY_STATE_LABEL,
  OVERLAY_STATE_TONE,
  overlayPartLabel,
  rejectPrefixOverlay,
  renderOverlayText,
  sizeChange,
  unifiedDiff,
} from '../../lib/token-saver/prefix';

const BADGE_TONE = {
  neutral: 'neutral',
  success: 'ok',
  warning: 'warn',
  danger: 'danger',
} as const;

/** "≈ 1,240 → ≈ 860 tokens (−31%)" */
function SizeLine({
  label,
  before,
  after,
  unit,
}: {
  label: string;
  before: number;
  after: number;
  unit: string;
}) {
  const { percent } = sizeChange(before, after);
  const sign = percent > 0 ? '+' : percent < 0 ? '−' : '';
  return (
    <div className="flex items-center gap-2">
      <dt className="w-20 text-ink-2">{label}</dt>
      <dd className="num">
        {formatNumber(before, 0)} → {formatNumber(after, 0)} {unit} ({sign}
        {Math.abs(percent)}%)
      </dd>
    </div>
  );
}

/**
 * #751 B9 "UI": the review of one overlay — the diff, the before → after
 * size, and Approve / Reject for a project admin (ADR-0075). Opening it reads
 * the overlay's text, which the API returns to an admin only. The diff is a
 * unified text in a CodeBlock until glass-ui has a diff viewer.
 */
export function OverlayReview({
  projectId,
  overlayId,
  onClose,
  onDecided,
}: {
  projectId: string;
  /** Null keeps the sheet closed. */
  overlayId: string | null;
  onClose: () => void;
  /** After an approve or reject, with the overlay as it now stands. */
  onDecided: (overlay: PrefixOverlayView) => void;
}) {
  const [detail, setDetail] = useState<PrefixOverlayDetailView>();
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  useEffect(() => {
    setDetail(undefined);
    if (!overlayId) return;
    let current = true;
    fetchPrefixOverlay(projectId, overlayId)
      .then((view) => {
        if (current) setDetail(view);
      })
      .catch((err) => {
        if (!current) return;
        showError(describePrefixError(err));
        onClose();
      });
    return () => {
      current = false;
    };
  }, [projectId, overlayId, showError, onClose]);

  const diff = useMemo(
    () =>
      detail
        ? unifiedDiff(
            lineDiff(
              renderOverlayText(detail.part, detail.originalText),
              renderOverlayText(detail.part, detail.content),
            ),
          )
        : '',
    [detail],
  );

  const decide = async (verb: 'approve' | 'reject') => {
    if (!overlayId) return;
    setBusy(true);
    try {
      const view = await (verb === 'approve'
        ? approvePrefixOverlay(projectId, overlayId)
        : rejectPrefixOverlay(projectId, overlayId));
      toast.success(
        verb === 'approve'
          ? 'Approved. It applies to new sessions in arm B.'
          : 'Rejected.',
      );
      onDecided(view);
      onClose();
    } catch (err) {
      showError(describePrefixError(err));
    } finally {
      setBusy(false);
    }
  };

  const proposed = detail?.state === 'proposed';

  return (
    <SheetRoot
      open={overlayId !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        title={detail ? `Review ${overlayPartLabel(detail.part)}` : 'Review'}
        description="An approved overlay replaces the original in launches of the test arm; the repository is never edited. It goes stale when the original changes."
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            {proposed ? (
              <>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => void decide('reject')}
                >
                  Reject
                </Button>
                <Button
                  variant="solid"
                  disabled={busy}
                  onClick={() => void decide('approve')}
                >
                  Approve
                </Button>
              </>
            ) : null}
          </div>
        }
      >
        {detail ? (
          <div className="flex flex-col gap-4">
            <dl className="flex flex-col gap-2 text-sm">
              <div className="flex items-center gap-2">
                <dt className="w-20 text-ink-2">State</dt>
                <dd>
                  <Badge
                    size="md"
                    tone={BADGE_TONE[OVERLAY_STATE_TONE[detail.state]]}
                    label={OVERLAY_STATE_LABEL[detail.state]}
                  />
                </dd>
              </div>
              <SizeLine
                label="Size"
                before={detail.originalBytes}
                after={detail.contentBytes}
                unit="bytes"
              />
              <SizeLine
                label="Tokens ≈"
                before={detail.originalEstTokens}
                after={detail.contentEstTokens}
                unit="tokens"
              />
            </dl>
            <div className="flex flex-col gap-1">
              <p className="text-ink-3 text-xs">
                Lines starting with “-” are removed, “+” are added.
              </p>
              <CodeBlock
                code={diff || 'No difference.'}
                language="diff"
                maxHeight={480}
                wrap
              />
            </div>
          </div>
        ) : (
          <Skeleton className="h-64 w-full" />
        )}
      </SheetContent>
    </SheetRoot>
  );
}
