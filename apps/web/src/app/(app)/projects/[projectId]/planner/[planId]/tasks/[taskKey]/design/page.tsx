'use client';

import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { type PlanDetail, projectRoleAtLeast } from '@nautelle/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { DesignViewer } from '../../../../../../../../../components/design/design-viewer';
import { FullScreenLayer } from '../../../../../../../../../components/design/full-screen-layer';
import { AsyncSection } from '../../../../../../../../../components/prerequisites/async-section';
import { api } from '../../../../../../../../../lib/api';
import {
  DESIGN_STATUS_LABEL,
  DESIGN_STATUS_PILL,
  describeDesignError,
} from '../../../../../../../../../lib/design/format';
import { designApi } from '../../../../../../../../../lib/design/href';
import { useDesign } from '../../../../../../../../../lib/design/use-design';
import {
  applyViewerChange,
  resolveViewerState,
} from '../../../../../../../../../lib/design/viewer-state';
import { useStepBack } from '../../../../../../../../../lib/navigation/step-back';
import { isNotFound } from '../../../../../../../../../lib/planner/format';
import { planApi, planHref } from '../../../../../../../../../lib/planner/href';
import { useErrorToast } from '../../../../../../../../../lib/section/use-error-toast';
import { useSection } from '../../../../../../../../../lib/section/use-section';
import { useProjectDetail } from '../../../../../use-project-detail';

/**
 * The design viewer (spec 223 "UI", D11): full screen over the shell, so the
 * mockup gets the whole width. The view — variant, revision, viewport, theme,
 * width — lives in the URL.
 */
export default function DesignViewerPage() {
  const params = useParams<{
    projectId: string;
    planId: string;
    taskKey: string;
  }>();
  const { projectId, planId } = params;
  const taskKey = decodeTaskKey(params.taskKey);
  if (taskKey === null) {
    return <TaskNotFound back={planHref(projectId, planId)} />;
  }
  return (
    <DesignViewerScreen
      projectId={projectId}
      planId={planId}
      taskKey={taskKey}
    />
  );
}

/** The task key from the route; null when it is not valid percent-encoding (C-165). */
function decodeTaskKey(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** A key that does not decode names no task: say so instead of crashing. */
function TaskNotFound({ back }: { back: string }) {
  return (
    <EmptyState
      title="Task not found"
      description="The link to this design is malformed. Open the task from its plan."
      action={
        <Link href={back} className={buttonClassName({ variant: 'glass' })}>
          Back to plan
        </Link>
      }
    />
  );
}

function DesignViewerScreen({
  projectId,
  planId,
  taskKey,
}: {
  projectId: string;
  planId: string;
  taskKey: string;
}) {
  const router = useRouter();
  const search = useSearchParams();

  const role = useProjectDetail(projectId).data?.role ?? 'viewer';
  const canOperate = projectRoleAtLeast(role, 'operator');
  const plan = useSection(
    () => api<PlanDetail>(planApi(projectId, planId)),
    [projectId, planId],
  );
  const task = plan.data?.tasks.find((t) => t.key === taskKey);
  const section = useDesign(projectId, planId, taskKey);
  const back = planHref(projectId, planId, taskKey);
  const leave = useStepBack(back);

  return (
    <FullScreenLayer
      label="Design viewer"
      onBack={leave}
      bar={{ label: 'Plan', title: 'Design', subtitle: taskKey }}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <Link
          href={back}
          // Below `lg` the phone back bar is the way out (#677).
          className={`${buttonClassName({ variant: 'ghost', size: 'sm' })} max-lg:hidden`}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to plan
        </Link>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-xs text-ink-3">
            {plan.data?.title ?? 'Plan'} · Design
          </span>
          <h1 className="truncate text-lg font-semibold">
            {task ? `${task.key} · ${task.title}` : taskKey}
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
          planId={planId}
          taskKey={taskKey}
          back={back}
          canOperate={canOperate}
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
              stillWorks: 'The plan and its other tasks are still available.',
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

/** No design row for the task: it was never suggested or switched on. */
function NoDesign({
  projectId,
  planId,
  taskKey,
  back,
  canOperate,
  onTurnedOn,
}: {
  projectId: string;
  planId: string;
  taskKey: string;
  back: string;
  canOperate: boolean;
  onTurnedOn: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();
  const turnOn = async () => {
    setBusy(true);
    try {
      await api(designApi(projectId, planId, taskKey), {
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
        title="No design for this task"
        description={
          canOperate
            ? 'Turn the design on to draw a mockup of this task before it is built.'
            : 'An operator can turn the design on for this task.'
        }
        action={
          canOperate ? (
            <Button variant="solid" disabled={busy} onClick={turnOn}>
              Turn design on
            </Button>
          ) : (
            <Link href={back} className={buttonClassName({ variant: 'glass' })}>
              Back to plan
            </Link>
          )
        }
      />
    </div>
  );
}
