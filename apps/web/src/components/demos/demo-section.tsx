'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Section } from '@andrewbehma/glass-ui/section';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import {
  type BoardCardDetail,
  type CardDemoView,
  isDemoActive,
} from '@nautelle/shared';
import { useCallback, useEffect, useState } from 'react';
import { fetchCardDemos, requestCardDemo } from '../../lib/demos/actions';
import {
  DEMO_PILL_STATUS,
  DEMO_STATUS_LABEL,
  describeDemoError,
  formatDuration,
  scenarioUrl,
} from '../../lib/demos/format';
import { Time } from '../../lib/format/time';
import { useErrorToast } from '../../lib/section/use-error-toast';
import { VideoPlayer } from './video-player';

/** `Round 2 · Automatic · 0:42`: the facts under the video, minus an unknown one. */
function demoFacts(demo: CardDemoView): string {
  return [
    `Round ${demo.round}`,
    demo.trigger === 'manual' ? 'Recorded again' : 'Automatic',
    formatDuration(demo.durationMs),
  ]
    .filter(Boolean)
    .join(' · ');
}

export function DemoStatusPill({ demo }: { demo: CardDemoView }) {
  return (
    <StatusPill
      status={DEMO_PILL_STATUS[demo.status]}
      label={DEMO_STATUS_LABEL[demo.status]}
    />
  );
}

/** What stands where the video would: a recording in flight, a failure, a skip. */
export function demoPlaceholder(demo: CardDemoView): string {
  if (isDemoActive(demo.status)) {
    return 'Recording the demo… the video appears here when it is ready.';
  }
  if (demo.reason) return demo.reason;
  return demo.status === 'failed'
    ? 'The recording failed.'
    : 'No demo was recorded.';
}

/**
 * The Demo section's body: the shown recording, its facts and the earlier ones.
 * Pure, so the states render without a network; `DemoSection` feeds it.
 */
export function DemoPanel({
  demos,
  cardTitle,
  prUrl,
  branch,
  canOperate,
  asking = false,
  pickedId,
  onPick,
  onRecordAgain,
  accept,
}: {
  /** Newest first, never empty. */
  demos: readonly CardDemoView[];
  cardTitle: string;
  prUrl: string | null;
  branch: string | null;
  canOperate: boolean;
  asking?: boolean;
  pickedId?: string;
  onPick?: (id: string) => void;
  onRecordAgain?: () => void;
  /** The card's Accept action; `null` when the viewer cannot accept now. */
  accept: { busy: boolean; run: () => void } | null;
}) {
  const latest = demos[0];
  const shown = demos.find((d) => d.id === pickedId) ?? latest;
  const earlier = demos.filter((d) => d.id !== shown.id);
  const scenario = scenarioUrl(prUrl, branch, shown.scenarioPath);

  return (
    <Section
      title="Demo"
      description="A recording of the card's change, made when its checks passed."
      actions={
        <div className="flex items-center gap-2">
          <DemoStatusPill demo={shown} />
          {canOperate ? (
            <Button
              variant="glass"
              disabled={asking || isDemoActive(latest.status)}
              onClick={onRecordAgain}
            >
              Record again
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        {shown.status === 'ready' && shown.contentUrl ? (
          <VideoPlayer
            key={shown.id}
            src={shown.contentUrl}
            title={`Demo of ${cardTitle}, round ${shown.round}`}
          />
        ) : (
          <p
            className="rounded-md bg-hover px-3 py-6 text-center text-ink-2 text-sm"
            role="status"
          >
            {demoPlaceholder(shown)}
          </p>
        )}

        {accept ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-3 text-xs">
              Watched it? Accept merges the pull request.
            </span>
            <Button variant="solid" disabled={accept.busy} onClick={accept.run}>
              Accept
            </Button>
          </div>
        ) : null}

        <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-3 text-xs">
          <dt className="sr-only">Recording</dt>
          <dd>{demoFacts(shown)}</dd>
          <dt className="sr-only">Recorded</dt>
          <dd>
            <Time value={shown.finishedAt ?? shown.createdAt} />
          </dd>
          {scenario ? (
            <>
              <dt className="sr-only">Scenario</dt>
              <dd className="min-w-0 truncate">
                <a
                  href={scenario}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent-ink underline underline-offset-2"
                >
                  {shown.scenarioPath}
                </a>
              </dd>
            </>
          ) : null}
        </dl>

        {earlier.length > 0 ? (
          <div className="flex flex-col gap-1">
            <h3 className="font-medium text-ink-2 text-xs">Earlier demos</h3>
            <ul className="flex flex-col divide-y divide-line">
              {earlier.map((demo) => (
                <li
                  key={demo.id}
                  className="flex items-center justify-between gap-2 py-1.5 text-xs"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <DemoStatusPill demo={demo} />
                    <span className="truncate text-ink-2">
                      {demoFacts(demo)} · <Time value={demo.createdAt} />
                    </span>
                  </span>
                  {demo.status === 'ready' ? (
                    <Button variant="ghost" onClick={() => onPick?.(demo.id)}>
                      Watch
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/**
 * C-371 (ADR-0090): the card's demo, first in its Overview. The latest
 * recording plays here; a recording in flight, a failure or a skip says so with
 * its reason. The card's Accept button sits right under the video, so watching
 * and merging happen in one place. A failed demo never blocks Accept.
 */
export function DemoSection({
  projectId,
  card,
  canOperate,
  accept,
}: {
  projectId: string;
  card: BoardCardDetail;
  canOperate: boolean;
  accept: { busy: boolean; run: () => void } | null;
}) {
  const [demos, setDemos] = useState<CardDemoView[]>();
  const [pickedId, setPickedId] = useState<string>();
  const [asking, setAsking] = useState(false);
  const showError = useErrorToast();
  const brief = card.demo ?? null;

  const load = useCallback(async () => {
    try {
      setDemos(await fetchCardDemos(projectId, card.number));
    } catch (err) {
      showError(describeDemoError(err));
    }
  }, [projectId, card.number, showError]);

  // The board's live refresh changes the card's brief when a recording starts,
  // finishes or fails; the list follows it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the brief is the trigger
  useEffect(() => {
    void load();
  }, [load, brief?.status, brief?.durationMs]);

  if (!demos) return <Skeleton className="h-48 w-full" />;
  if (demos.length === 0) return null;

  const recordAgain = async () => {
    setAsking(true);
    try {
      await requestCardDemo(projectId, card.number);
      setPickedId(undefined);
      await load();
    } catch (err) {
      showError(describeDemoError(err));
    } finally {
      setAsking(false);
    }
  };

  return (
    <DemoPanel
      demos={demos}
      cardTitle={card.title}
      prUrl={card.prUrl}
      branch={card.branch}
      canOperate={canOperate}
      asking={asking}
      pickedId={pickedId}
      onPick={setPickedId}
      onRecordAgain={() => void recordAgain()}
      accept={accept}
    />
  );
}
