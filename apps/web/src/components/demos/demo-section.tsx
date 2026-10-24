'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Section } from '@andrewbehma/glass-ui/section';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import {
  type BoardCardDetail,
  type CardDemoView,
  isDemoActive,
} from '@nautelle/shared';
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { attachmentHref } from '../../lib/attachments/format';
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

/** `Round 2 · Automatic · 0:42`: one earlier demo, minus an unknown fact. */
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

/** The line under the section title, as in the S-12 states. */
function demoDescription(demo: CardDemoView): string {
  if (isDemoActive(demo.status)) {
    return "DemoFlow is walking the change on the project's runner.";
  }
  if (demo.status === 'ready') {
    return 'Recorded on the runner when the checks turned green. Watch it before you merge.';
  }
  return `Round ${demo.round}`;
}

/** Where the video would be, for a demo that has none. */
function DemoStand({ demo }: { demo: CardDemoView }) {
  if (isDemoActive(demo.status)) {
    return (
      <div
        role="status"
        className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-md bg-black px-4 text-center text-sm text-white/80"
      >
        <span
          aria-hidden="true"
          className="size-3 animate-pulse rounded-full bg-danger"
        />
        {demoPlaceholder(demo)}
      </div>
    );
  }
  return demo.status === 'failed' ? (
    <Banner tone="danger" title="The recording failed.">
      {demo.reason ?? 'The runner gave no reason.'}
    </Banner>
  ) : (
    <Banner tone="info" title="No demo was recorded.">
      {demo.reason ?? 'The runner gave no reason.'}
    </Banner>
  );
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
  const length = formatDuration(shown.durationMs);
  const facts: { term: string; detail: ReactNode }[] = [
    {
      term: isDemoActive(shown.status)
        ? 'Started'
        : shown.status === 'ready'
          ? 'Recorded'
          : DEMO_STATUS_LABEL[shown.status],
      detail: (
        <>
          Round {shown.round} ·{' '}
          <Time value={shown.finishedAt ?? shown.createdAt} />
        </>
      ),
    },
    {
      term: 'Trigger',
      detail:
        shown.trigger === 'manual'
          ? `Recorded again${shown.requestedByName ? ` by ${shown.requestedByName}` : ''}`
          : 'Checks turned green',
    },
    ...(length ? [{ term: 'Length', detail: length }] : []),
    ...(scenario
      ? [
          {
            term: 'Scenario',
            detail: (
              <a
                href={scenario}
                target="_blank"
                rel="noreferrer"
                className="break-all font-mono text-accent-ink underline underline-offset-2"
              >
                {shown.scenarioPath}
              </a>
            ),
          },
        ]
      : []),
  ];

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          Demo
          <DemoStatusPill demo={shown} />
        </span>
      }
      description={demoDescription(shown)}
      actions={
        canOperate ? (
          <Button
            variant="glass"
            disabled={asking || isDemoActive(latest.status)}
            onClick={onRecordAgain}
          >
            Record again
          </Button>
        ) : null
      }
    >
      <div className="flex min-w-0 flex-col gap-4">
        {shown.status === 'ready' && shown.contentUrl ? (
          <VideoPlayer
            key={shown.id}
            src={attachmentHref({ contentUrl: shown.contentUrl })}
            title={`Demo of ${cardTitle}, round ${shown.round}`}
          />
        ) : (
          <DemoStand demo={shown} />
        )}

        {accept ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-ink-2 text-sm">
              {shown.status === 'ready'
                ? 'Watched it? Accept merges the pull request.'
                : 'Accept merges the pull request; a demo never blocks it.'}
            </span>
            <Button variant="solid" disabled={accept.busy} onClick={accept.run}>
              Accept
            </Button>
          </div>
        ) : null}

        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          {facts.map((fact) => (
            <Fragment key={fact.term}>
              <dt className="text-ink-3">{fact.term}</dt>
              <dd className="min-w-0 text-ink-1">{fact.detail}</dd>
            </Fragment>
          ))}
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
