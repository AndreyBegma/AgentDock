'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Progress } from '@andrewbehma/glass-ui/progress';
import { Section } from '@andrewbehma/glass-ui/section';
import { toast } from '@andrewbehma/glass-ui/toast';
import type {
  PrefixOverlayView,
  PrefixSummaryView,
  PrefixTopPartView,
} from '@nautelle/shared';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { formatNumber } from '../../lib/format';
import { useErrorToast } from '../../lib/section/use-error-toast';
import { useSection } from '../../lib/section/use-section';
import {
  budgetFill,
  describePrefixError,
  fetchPrefixOverlays,
  fetchPrefixSummary,
  launchKindLabel,
  ORIGIN_LABEL,
  OVERLAY_STATE_LABEL,
  OVERLAY_STATE_TONE,
  openOverlayPullRequest,
  PART_KIND_LABEL,
  proposePrefixOverlay,
} from '../../lib/token-saver/prefix';
import { AsyncSection } from '../prerequisites/async-section';
import { ResponsiveRows } from '../responsive-rows/responsive-rows';
import { OverlayReview } from './overlay-review';

const BADGE_TONE = {
  neutral: 'neutral',
  success: 'ok',
  warning: 'warn',
  danger: 'danger',
} as const;

const num = (text: string) => <span className="num">{text || '—'}</span>;

/** The overlay a row shows: its open or stale one, else its newest approved. */
function rowOverlay(
  part: PrefixTopPartView,
  overlays: readonly PrefixOverlayView[],
): { id: string; state: PrefixOverlayView['state'] } | null {
  if (part.overlay) return part.overlay;
  if (!part.overlayPart) return null;
  const approved = overlays.find(
    (o) => o.part === part.overlayPart && o.state === 'approved',
  );
  return approved ? { id: approved.id, state: approved.state } : null;
}

/**
 * #751 B3 "UI": the Token saver page's Prefix section — a budget bar per
 * launch kind, the top parts with their origin and ≈tokens, the overlay state
 * of each, and for an admin Propose, Review and Open a pull request. It loads
 * and fails on its own.
 */
export function PrefixSection({
  projectId,
  range,
  isAdmin,
}: {
  projectId: string;
  range: { from: string; to: string };
  isAdmin: boolean;
}) {
  const section = useSection(async () => {
    const [summary, overlays] = await Promise.all([
      fetchPrefixSummary(projectId, range),
      fetchPrefixOverlays(projectId).catch(() => []),
    ]);
    return { summary, overlays };
  }, [projectId, range.from, range.to]);
  const { retry } = section;
  const showError = useErrorToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const closeReview = useCallback(() => setReviewing(null), []);

  const act = async (key: string, task: () => Promise<string>) => {
    setBusy(key);
    try {
      toast.success(await task());
    } catch (err) {
      showError(describePrefixError(err));
    } finally {
      setBusy(null);
      retry();
    }
  };

  const settingsHref = `/projects/${encodeURIComponent(projectId)}/settings?tab=token-saver`;

  return (
    <Section
      title="Launch prefix"
      description={
        <>
          What every turn re-reads: CLAUDE.md, the injected rules, skills and
          MCP schemas. The median is measured from each launch's first request;
          part sizes are ≈ estimates (bytes ÷ 4). An approved overlay replaces a
          part in the test arm and never edits the repository.{' '}
          <Link
            href={settingsHref}
            className="text-accent-ink underline underline-offset-2"
          >
            Budget and selection
          </Link>
          .
        </>
      }
      surface="none"
      pad="none"
    >
      <AsyncSection
        section={section}
        isEmpty={(data) => data.summary.kinds.length === 0}
        unavailable={{
          title: 'The launch prefix is not answering',
          stillWorks: 'The rest of the page still loads.',
        }}
        empty={
          <p className="text-ink-3 text-sm">
            No launch in this range reported its prefix yet. It needs a runner
            that advertises prefix measurement.
          </p>
        }
      >
        {({ summary, overlays }) => (
          <PrefixBody
            summary={summary}
            overlays={overlays}
            isAdmin={isAdmin}
            busy={busy}
            onPropose={(part) =>
              void act(`propose:${part}`, async () => {
                await proposePrefixOverlay(projectId, part);
                return 'Proposal queued. It appears here when the runner answers.';
              })
            }
            onReview={setReviewing}
            onPullRequest={(overlayId) =>
              void act(`pr:${overlayId}`, async () => {
                const { number } = await openOverlayPullRequest(
                  projectId,
                  overlayId,
                );
                return `Card #${number} created on the Board.`;
              })
            }
          />
        )}
      </AsyncSection>
      {isAdmin ? (
        <OverlayReview
          projectId={projectId}
          overlayId={reviewing}
          onClose={closeReview}
          onDecided={() => retry()}
        />
      ) : null}
    </Section>
  );
}

function PrefixBody({
  summary,
  overlays,
  isAdmin,
  busy,
  onPropose,
  onReview,
  onPullRequest,
}: {
  summary: PrefixSummaryView;
  overlays: readonly PrefixOverlayView[];
  isAdmin: boolean;
  busy: string | null;
  onPropose: (part: string) => void;
  onReview: (overlayId: string) => void;
  onPullRequest: (overlayId: string) => void;
}) {
  const over = summary.kinds.filter((k) => k.overBudget);
  const pulled = useMemo(
    () =>
      new Set(
        overlays.filter((o) => o.pullRequestCardId !== null).map((o) => o.id),
      ),
    [overlays],
  );

  const columns = [
    {
      id: 'part',
      header: 'Part',
      cell: (p: PrefixTopPartView) => (
        <span className="flex flex-col">
          <span>{p.name}</span>
          <span className="text-ink-3 text-xs">
            {PART_KIND_LABEL[p.kind]}
            {p.path ? ` · ${p.path}` : ''}
          </span>
        </span>
      ),
    },
    {
      id: 'origin',
      header: 'Origin',
      cell: (p: PrefixTopPartView) => ORIGIN_LABEL[p.origin],
    },
    {
      id: 'tokens',
      header: 'Size ≈',
      align: 'end' as const,
      cell: (p: PrefixTopPartView) =>
        num(`${formatNumber(p.estTokens, 0)} tokens`),
    },
    {
      id: 'launches',
      header: 'Launches',
      align: 'end' as const,
      cell: (p: PrefixTopPartView) => num(formatNumber(p.launches, 0)),
    },
    {
      id: 'overlay',
      header: 'Overlay',
      cell: (p: PrefixTopPartView) => {
        const overlay = rowOverlay(p, overlays);
        return overlay ? (
          <Badge
            size="md"
            tone={BADGE_TONE[OVERLAY_STATE_TONE[overlay.state]]}
            label={OVERLAY_STATE_LABEL[overlay.state]}
          />
        ) : p.overlayPart ? (
          <span className="text-ink-3">None</span>
        ) : (
          <span className="text-ink-3">—</span>
        );
      },
    },
    ...(isAdmin
      ? [
          {
            id: 'actions',
            header: 'Actions',
            align: 'end' as const,
            cell: (p: PrefixTopPartView) => {
              const overlay = rowOverlay(p, overlays);
              if (!p.overlayPart) return null;
              if (overlay?.state === 'proposed') {
                return (
                  <Button size="sm" onClick={() => onReview(overlay.id)}>
                    Review
                  </Button>
                );
              }
              if (overlay?.state === 'approved') {
                return pulled.has(overlay.id) ? (
                  <span className="text-ink-3 text-xs">PR card open</span>
                ) : (
                  <Button
                    size="sm"
                    disabled={busy === `pr:${overlay.id}`}
                    onClick={() => onPullRequest(overlay.id)}
                  >
                    Open a pull request
                  </Button>
                );
              }
              // `stale` re-proposes on its own (B10); nothing else is open.
              if (overlay?.state === 'stale') return null;
              return (
                <Button
                  size="sm"
                  disabled={busy === `propose:${p.overlayPart}`}
                  onClick={() => onPropose(p.overlayPart as string)}
                >
                  Propose
                </Button>
              );
            },
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      {over.length > 0 ? (
        <Banner tone="warn" title="Over the prefix budget">
          {`${over.map((k) => launchKindLabel(k.launchKind)).join(', ')} — the median prefix exceeds ${formatNumber(summary.budgetTokens, 0)} tokens. Warnings never block a launch.`}
        </Banner>
      ) : null}
      <ul className="flex flex-col gap-3">
        {summary.kinds.map((k) => {
          const tokens = k.medianTokens ?? k.medianEstTokens;
          return (
            <li key={k.launchKind}>
              <Progress
                value={budgetFill(tokens, summary.budgetTokens)}
                max={1}
                tone={k.overBudget ? 'danger' : 'ok'}
                label={`${launchKindLabel(k.launchKind)}:${
                  k.medianTokens === null ? '≈ ' : ''
                }${formatNumber(tokens, 0)} of ${formatNumber(summary.budgetTokens, 0)} tokens`}
                hint={`${formatNumber(k.launches, 0)} launches${
                  k.medianTokens === null
                    ? ' — no first request yet, parts only'
                    : ''
                }`}
              />
            </li>
          );
        })}
      </ul>
      {summary.topParts.length > 0 ? (
        <ResponsiveRows
          label="Largest prefix parts"
          stackBelow="desktop"
          rows={[...summary.topParts]}
          getRowId={(p) => `${p.kind}:${p.name}:${p.path}`}
          columns={columns}
        />
      ) : null}
    </div>
  );
}
