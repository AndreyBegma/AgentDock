'use client';

import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { projectRoleAtLeast } from '@nautelle/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { DesignViewer } from '../../../../../../../../components/design/design-viewer';
import { FullScreenLayer } from '../../../../../../../../components/design/full-screen-layer';
import { AsyncSection } from '../../../../../../../../components/prerequisites/async-section';
import { api } from '../../../../../../../../lib/api';
import { fetchStack } from '../../../../../../../../lib/board/actions';
import { isNotFound } from '../../../../../../../../lib/board/format';
import { boardStackPageHref } from '../../../../../../../../lib/board/href';
import {
  DESIGN_STATUS_LABEL,
  DESIGN_STATUS_PILL,
  describeDesignError,
} from '../../../../../../../../lib/design/format';
import { stackDesignApi } from '../../../../../../../../lib/design/href';
import { useStackDesign } from '../../../../../../../../lib/design/use-design';
import {
  applyViewerChange,
  resolveViewerState,
} from '../../../../../../../../lib/design/viewer-state';
import { useStepBack } from '../../../../../../../../lib/navigation/step-back';
import { useErrorToast } from '../../../../../../../../lib/section/use-error-toast';
import { useSection } from '../../../../../../../../lib/section/use-section';
import { useProjectDetail } from '../../../../use-project-detail';

/**
 * #480 (ADR-0044): a stack's shared design in the viewer of spec 223, full
 * screen over the shell — the same Generate, comments, Revise and Approve as
 * a card's design. Approving it lifts the design-first gate on every card of
 * the stack; it starts none of them.
 */
export default function StackDesignViewerPage() {
  const params = useParams<{ projectId: string; number: string }>();
  const { projectId } = params;
  const number = Number(params.number);
  const router = useRouter();
  const search = useSearchParams();

  const role = useProjectDetail(projectId).data?.role ?? 'viewer';
  const canOperate = projectRoleAtLeast(role, 'operator');
  const section = useStackDesign(projectId, number);
  const stack = useSection(
    () => fetchStack(projectId, number),
    [projectId, number, section.data?.updatedAt],
  );
  const back = boardStackPageHref(projectId, number);
  const leave = useStepBack(back);

  if (!Number.isInteger(number) || number < 1 || isNotFound(stack.error)) {
    return (
      <FullScreenLayer
        label="Design viewer"
        onBack={() => router.push(`/projects/${projectId}/board`)}
        bar={{ label: 'Board' }}
      >
        <div className="p-6">
          <EmptyState
            title="Stack not found"
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

  return (
    <FullScreenLayer
      label="Design viewer"
      onBack={leave}
      bar={{
        label: 'Stack',
        title: 'Design',
        subtitle: stack.data?.label ?? `S-${number}`,
      }}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <Link
          href={back}
          // Below `lg` the phone back bar is the way out (#677).
          className={`${buttonClassName({ variant: 'ghost', size: 'sm' })} max-lg:hidden`}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to the stack
        </Link>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-xs text-ink-3">Board · Stack design</span>
          <h1 className="truncate text-lg font-semibold">
            {stack.data
              ? `${stack.data.label} · ${stack.data.title}`
              : `S-${number}`}
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
          canOperate={canOperate}
          onTurnedOn={section.retry}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col *:min-h-0 *:flex-1">
          <AsyncSection
            section={section}
            unavailable={{
              title: 'The design could not be loaded',
              stillWorks: 'The board and its stacks are still available.',
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
                approval={{
                  consequence:
                    'Every card of the stack may run once it is approved. Approving starts none of them.',
                }}
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

/** No design row for the stack: it was never switched on. */
function NoDesign({
  projectId,
  number,
  canOperate,
  onTurnedOn,
}: {
  projectId: string;
  number: number;
  canOperate: boolean;
  onTurnedOn: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();
  const turnOn = async () => {
    setBusy(true);
    try {
      await api(stackDesignApi(projectId, number), {
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
        title="No design for this stack"
        description={
          canOperate
            ? 'Turn the design on to draw one mockup of the whole result. No card of the stack runs until it is approved.'
            : 'An operator can turn the stack design on.'
        }
        action={
          canOperate ? (
            <Button variant="solid" disabled={busy} onClick={turnOn}>
              Turn design on
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
