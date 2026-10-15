'use client';

import { projectRoleAtLeast } from '@agentdock/shared';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { toast } from '@andrewbehma/glass-ui/toast';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { DesignViewer } from '../../../../../../../../components/design/design-viewer';
import { FullScreenLayer } from '../../../../../../../../components/design/full-screen-layer';
import { AsyncSection } from '../../../../../../../../components/prerequisites/async-section';
import { api } from '../../../../../../../../lib/api';
import { fetchCard, runCard } from '../../../../../../../../lib/board/actions';
import {
  approveAndRun,
  approveConsequence,
  offersApproveAndRun,
} from '../../../../../../../../lib/board/design-actions';
import {
  describeBoardError,
  isNotFound,
} from '../../../../../../../../lib/board/format';
import { boardCardHref } from '../../../../../../../../lib/board/href';
import {
  DESIGN_STATUS_LABEL,
  DESIGN_STATUS_PILL,
  describeDesignError,
} from '../../../../../../../../lib/design/format';
import { cardDesignApi } from '../../../../../../../../lib/design/href';
import { useCardDesign } from '../../../../../../../../lib/design/use-design';
import {
  applyViewerChange,
  resolveViewerState,
} from '../../../../../../../../lib/design/viewer-state';
import { useErrorToast } from '../../../../../../../../lib/section/use-error-toast';
import { useSection } from '../../../../../../../../lib/section/use-section';
import { useProjectDetail } from '../../../../use-project-detail';

/**
 * A board card's design viewer (#243): the viewer of spec 223 at the card's
 * base, full screen over the shell. With "Continue after design" off, Approve
 * also offers **Approve & run** (D6).
 */
export default function CardDesignViewerPage() {
  const params = useParams<{ projectId: string; number: string }>();
  const { projectId } = params;
  const number = Number(params.number);
  const router = useRouter();
  const search = useSearchParams();

  const role = useProjectDetail(projectId).data?.role ?? 'viewer';
  const canOperate = projectRoleAtLeast(role, 'operator');
  const section = useCardDesign(projectId, number);
  // The card's switch and title; refetched when the design changes under it.
  const card = useSection(
    () => fetchCard(projectId, number),
    [projectId, number, section.data?.updatedAt],
  );
  const back = boardCardHref(projectId, number);

  if (!Number.isInteger(number) || number < 1 || isNotFound(card.error)) {
    return (
      <FullScreenLayer label="Design viewer">
        <div className="p-6">
          <EmptyState
            title="Card not found"
            description="It was removed, or you are not a member of its project."
            action={
              <Link
                href={`/projects/${projectId}/board`}
                className={buttonClassName({ variant: 'glass' })}
              >
                Back to the board
              </Link>
            }
          />
        </div>
      </FullScreenLayer>
    );
  }

  const continueAfterDesign = card.data?.continueAfterDesign ?? false;
  const approval = {
    consequence: approveConsequence(continueAfterDesign),
    onApproveAndRun:
      card.data && offersApproveAndRun(card.data)
        ? async (revisionId: string) => {
            let approved = false;
            try {
              await approveAndRun(
                {
                  approve: async (id) => {
                    await section.actions.approve({ revisionId: id });
                    approved = true;
                  },
                  run: () => runCard(projectId, number),
                },
                revisionId,
              );
              toast.success(`Approved. Started a worker on C-${number}.`);
            } catch (error) {
              // An approval refusal was toasted by the design hook; the dialog stays.
              if (!approved) throw error;
              toast.error(describeBoardError(error));
            }
          }
        : undefined,
  };

  return (
    <FullScreenLayer label="Design viewer">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <Link
          href={back}
          className={buttonClassName({ variant: 'ghost', size: 'sm' })}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to the board
        </Link>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-xs text-ink-3">Board · Design</span>
          <h1 className="truncate text-lg font-semibold">
            {card.data
              ? `${card.data.label} · ${card.data.title}`
              : `C-${number}`}
          </h1>
        </div>
        {section.data ? (
          <StatusPill
            status={DESIGN_STATUS_PILL[section.data.status]}
            label={DESIGN_STATUS_LABEL[section.data.status]}
          />
        ) : null}
      </header>

      {section.data === undefined && isNotFound(section.error) ? (
        <NoDesign
          projectId={projectId}
          number={number}
          back={back}
          canOperate={canOperate && card.data?.round === null}
          onTurnedOn={section.retry}
        />
      ) : (
        // AsyncSection wraps its states in a div of its own: it takes the
        // height left under the header, so the stage scrolls, not the overlay.
        <div className="flex min-h-0 flex-1 flex-col *:min-h-0 *:flex-1">
          <AsyncSection
            section={section}
            unavailable={{
              title: 'The design could not be loaded',
              stillWorks: 'The board and its cards are still available.',
            }}
            empty={null}
          >
            {(design) => (
              <DesignViewer
                projectId={projectId}
                design={design}
                state={resolveViewerState(
                  search,
                  design.revisions,
                  design.viewports,
                )}
                canOperate={canOperate}
                busy={section.busy}
                actions={section.actions}
                approval={approval}
                launch={card.data}
                onChange={(change) =>
                  router.replace(
                    `${window.location.pathname}${applyViewerChange(search, change)}`,
                    { scroll: false },
                  )
                }
              />
            )}
          </AsyncSection>
        </div>
      )}
    </FullScreenLayer>
  );
}

/** No design row for the card: it was never switched on. */
function NoDesign({
  projectId,
  number,
  back,
  canOperate,
  onTurnedOn,
}: {
  projectId: string;
  number: number;
  back: string;
  canOperate: boolean;
  onTurnedOn: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();
  const turnOn = async () => {
    setBusy(true);
    try {
      await api(cardDesignApi(projectId, number), {
        method: 'PATCH',
        body: { needed: true },
      });
      onTurnedOn();
    } catch (error) {
      showError(describeDesignError(error, projectId));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="p-6">
      <EmptyState
        title="No design for this card"
        description={
          canOperate
            ? 'Turn the design on to draw a mockup of this card before it is built.'
            : 'An operator can turn the design on, until the card has started.'
        }
        action={
          canOperate ? (
            <Button variant="solid" disabled={busy} onClick={turnOn}>
              Turn design on
            </Button>
          ) : (
            <Link href={back} className={buttonClassName({ variant: 'glass' })}>
              Back to the board
            </Link>
          )
        }
      />
    </div>
  );
}
