'use client';

import {
  type CardDesignLaunchRequest,
  DESIGN_VIEWPORT_MAX_PX,
  DESIGN_VIEWPORT_MIN_PX,
  type DesignCommentRequest,
  type MockupPinMarker,
  type TaskDesignPatchRequest,
  type TaskDesignView,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { ResizableFrame } from '@andrewbehma/glass-ui/resizable-frame';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { SidePanel } from '@andrewbehma/glass-ui/side-panel';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LaunchCard } from '../../lib/board/launch';
import {
  approveBlock,
  designWriteBlock,
  isOpen,
  pinMarkers,
  pinNumbers,
  reviseBlock,
} from '../../lib/design/comments';
import type { DesignBusy } from '../../lib/design/use-design';
import { useElementWidth } from '../../lib/design/use-element-width';
import {
  revisionsOf,
  type ViewerChange,
  type ViewerState,
  variantsOf,
} from '../../lib/design/viewer-state';
import {
  boxSize,
  dragStep,
  FRAME_GUTTER_PX,
  type FrameDrag,
  frameZoom,
  stepZoom,
  wheelZoom,
  zoomKey,
} from '../../lib/design/zoom';
import { LaunchPopover } from '../board/launch-popover';
import { ApproveDialog } from './approve-dialog';
import { CommentsPanel } from './comments-panel';
import { DesignFailure } from './design-failure';
import { DesignProgress } from './design-progress';
import { GeneratePanel } from './generate-panel';
import { MockupBanner } from './mockup-banner';
import { type FramePin, MockupFrame } from './mockup-frame';
import { PinComposer } from './pin-composer';
import { ViewerToolbar } from './viewer-toolbar';

export interface DesignViewerActions {
  patch: (body: TaskDesignPatchRequest) => Promise<unknown>;
  generate: (body?: CardDesignLaunchRequest) => Promise<unknown>;
  comment: (body: DesignCommentRequest) => Promise<unknown>;
  revise: (body?: CardDesignLaunchRequest) => Promise<unknown>;
  approve: (body: { revisionId: string }) => Promise<unknown>;
  stop: () => Promise<unknown>;
}

/**
 * The design viewer's workspace (spec 223 D9–D11, "UI"): the toolbar, the
 * mockup in its frame, and the right panel with the comments, **Revise
 * design** and **Approve**. The page owns loading and the URL; this owns the
 * pin draft and the dialogs.
 */
export function DesignViewer({
  projectId,
  design,
  state,
  canOperate,
  busy,
  actions,
  approval,
  launch,
  onChange,
}: {
  projectId: string;
  design: TaskDesignView;
  state: ViewerState;
  canOperate: boolean;
  busy: DesignBusy | null;
  actions: DesignViewerActions;
  /** A card's design (#243 D6): what approving does, and **Approve & run** when it starts nothing. */
  approval?: {
    consequence: string;
    onApproveAndRun?: (revisionId: string) => Promise<unknown>;
  };
  /**
   * A card's design (#322 D1): the card, so Generate and Revise open the
   * launch popover. A plan task's design (ADR-0025) leaves it out and keeps
   * its plain buttons.
   */
  launch?: LaunchCard;
  onChange: (change: ViewerChange) => void;
}) {
  const [pinMode, setPinMode] = useState(false);
  // The scale a pin was placed at travels with it: `frame` is the scaled box.
  const [draft, setDraft] = useState<(FramePin & { zoom: number }) | null>(
    null,
  );
  const [approveOpen, setApproveOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  // While the frame's edge is dragged the width lives here; the URL takes it
  // once, on release.
  const [drag, setDrag] = useState<FrameDrag | null>(null);
  const view = drag === null ? state : { ...state, width: drag.width };

  // Zoom (spec 335): Fit is worked out from the room the stage has; the
  // frame's gutter is not room for the mockup. A drag holds its zoom (#394).
  const [measure, stageWidth] = useElementWidth();
  const zoom = frameZoom(
    state.zoom,
    stageWidth - FRAME_GUTTER_PX * 2,
    view.width,
    drag,
  );
  const stage = useRef<HTMLElement>(null);
  const hasMockup = state.revision !== null;
  // The wheel and the keys read the zoom through a ref: several wheel events
  // land before the URL has taken the first.
  const live = useRef({ zoom, onChange });
  useEffect(() => {
    live.current = { zoom, onChange };
  });

  // Not React's `onWheel`: that listener is passive, and the browser's own
  // page zoom can only be stopped from an active one (D6).
  useEffect(() => {
    const element = stage.current;
    if (!element || !hasMockup) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const next = wheelZoom(live.current.zoom, event.deltaY);
      live.current.zoom = next;
      live.current.onChange({ kind: 'zoom', zoom: next });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [hasMockup]);

  const onStageKeyDown = (event: React.KeyboardEvent) => {
    const key = zoomKey(event);
    if (!key || !hasMockup) return;
    // A field keeps its own keys (the typed width, a pin's comment).
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) {
      return;
    }
    event.preventDefault();
    onChange({
      kind: 'zoom',
      zoom: key === 'fit' ? 'fit' : stepZoom(zoom, key === 'in' ? 1 : -1),
    });
  };

  const writeBlock = designWriteBlock(design, canOperate);
  const reviseReason = reviseBlock(design, canOperate);
  const approveReason = approveBlock(design, canOperate);
  const revisionId = state.revision?.id ?? null;
  const screen = { viewport: state.viewport.name, theme: state.theme };
  const variants = variantsOf(design.revisions);
  const openCount = design.comments.filter(isOpen).length;

  const draftNumber = pinNumbers(design.comments, revisionId).size + 1;
  const markers = useMemo<MockupPinMarker[]>(() => {
    const saved = pinMarkers(
      design.comments,
      revisionId,
      state.viewport.name,
      state.theme,
    );
    return draft
      ? [...saved, { n: draftNumber, x: draft.x, y: draft.y }]
      : saved;
  }, [
    design.comments,
    revisionId,
    state.viewport.name,
    state.theme,
    draft,
    draftNumber,
  ]);

  const candidates = variants.flatMap((v) => {
    const latest = revisionsOf(design.revisions, v)[0];
    return latest ? [latest] : [];
  });

  const panel = (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap gap-2">
        {launch ? (
          <LaunchPopover
            projectId={projectId}
            card={launch}
            kind="design"
            variant="glass"
            label={
              busy === 'revise' ? 'Starting…' : `Revise design (${openCount})`
            }
            actionLabel="Revise"
            disabled={reviseReason !== null || busy !== null}
            title={reviseReason ?? undefined}
            onLaunch={actions.revise}
          />
        ) : (
          <Button
            variant="glass"
            disabled={reviseReason !== null || busy !== null}
            title={reviseReason ?? undefined}
            onClick={() => void actions.revise().catch(() => {})}
          >
            {busy === 'revise' ? 'Starting…' : `Revise design (${openCount})`}
          </Button>
        )}
        <Button
          variant="solid"
          disabled={approveReason !== null || busy !== null}
          title={approveReason ?? undefined}
          onClick={() => setApproveOpen(true)}
        >
          Approve
        </Button>
      </div>
      {reviseReason && writeBlock === null ? (
        <p className="text-xs text-ink-3">{reviseReason}</p>
      ) : null}
      {state.revision ? (
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">{state.revision.title}</h2>
          <p className="text-sm whitespace-pre-wrap text-ink-2">
            {state.revision.rationale}
          </p>
        </div>
      ) : null}
      <CommentsPanel
        projectId={projectId}
        owner={design.owner}
        canOperate={canOperate}
        comments={design.comments}
        revisionId={revisionId}
        screen={screen}
        writeBlock={writeBlock}
        busy={busy === 'comment'}
        onComment={async (body) => {
          if (!revisionId) return;
          await actions.comment({ ...body, revisionId });
        }}
      />
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1">
      {/* The stage: the zoom's shortcuts act here and nowhere else (D6). */}
      <section
        ref={stage}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the stage takes focus so the zoom keys have a place to act
        tabIndex={0}
        aria-label="Mockup stage"
        onKeyDown={onStageKeyDown}
        className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-4 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <MockupBanner design={design} />
        {design.progress ? (
          <DesignProgress
            projectId={projectId}
            progress={design.progress}
            canStop={canOperate}
            stopping={busy === 'stop'}
            onStop={() => void actions.stop().catch(() => {})}
          />
        ) : design.lastFailure ? (
          <DesignFailure
            failure={design.lastFailure}
            canRetry={canOperate && design.needed}
            retrying={busy === 'generate' || busy === 'revise'}
            onRetry={() =>
              void (
                design.lastFailure?.mode === 'revise'
                  ? actions.revise()
                  : actions.generate()
              ).catch(() => {})
            }
          />
        ) : null}
        {state.revision ? (
          <>
            <ViewerToolbar
              state={view}
              zoom={zoom}
              viewports={design.viewports}
              variants={variants}
              revisions={revisionsOf(design.revisions, state.variant)}
              pinMode={pinMode}
              canPin={writeBlock === null}
              onChange={onChange}
              onPinMode={(on) => {
                setPinMode(on);
                if (!on) setDraft(null);
              }}
            />
            {/* Below `lg` the panel is a sheet; its way in sits above the frame. */}
            <Button
              variant="glass"
              className="shrink-0 self-start lg:hidden"
              onClick={() => setSheetOpen(true)}
            >
              Comments and review ({openCount} open)
            </Button>
            {/* D1: the box is the scaled size, the mockup inside keeps its layout size. */}
            <div ref={measure} className="w-full min-w-0 shrink-0">
              <ResizableFrame
                className="shrink-0"
                width={boxSize(view.width, zoom)}
                height={boxSize(state.viewport.height, zoom)}
                min={boxSize(DESIGN_VIEWPORT_MIN_PX, zoom)}
                max={boxSize(DESIGN_VIEWPORT_MAX_PX, zoom)}
                labels={{ resize: 'Resize the mockup' }}
                // D5: the box reports scaled px; the width is the layout width.
                onWidthChange={(box) =>
                  setDrag((current) => dragStep(current, box, zoom))
                }
                onWidthCommit={(box) => {
                  setDrag(null);
                  onChange({
                    kind: 'width',
                    width: dragStep(drag, box, zoom).width,
                  });
                }}
              >
                <div
                  className="origin-top-left"
                  style={{
                    width: view.width,
                    height: state.viewport.height,
                    transform: `scale(${zoom})`,
                  }}
                >
                  <MockupFrame
                    src={state.revision.htmlUrl}
                    title={`Mockup: ${state.revision.title}`}
                    theme={state.theme}
                    pinMode={pinMode && writeBlock === null}
                    pins={markers}
                    onPin={(pin) => {
                      if (writeBlock === null) setDraft({ ...pin, zoom });
                    }}
                  />
                </div>
              </ResizableFrame>
            </div>
          </>
        ) : design.progress ? null : (
          <GeneratePanel
            projectId={projectId}
            design={design}
            writeBlock={writeBlock}
            busy={busy === 'generate' || busy === 'patch'}
            onPatch={actions.patch}
            onGenerate={actions.generate}
            launch={launch}
          />
        )}
      </section>

      {state.revision ? (
        <>
          <SidePanel
            storageKey="agentdock.design-viewer.panel"
            aria-label="Comments and review"
            labels={{
              resize: 'Resize the comments panel',
              expand: 'Show the comments',
            }}
            side="end"
            minWidth={320}
            maxWidth={560}
            defaultWidth={380}
            className="hidden overflow-y-auto lg:flex"
          >
            {panel}
          </SidePanel>
          <SheetRoot open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent title="Comments and review" side="bottom" pad="none">
              {panel}
            </SheetContent>
          </SheetRoot>
        </>
      ) : null}

      <PinComposer
        pin={draft}
        zoom={draft?.zoom ?? zoom}
        number={draftNumber}
        screen={`${screen.viewport} · ${screen.theme}`}
        busy={busy === 'comment'}
        onCancel={() => setDraft(null)}
        onSave={async (body) => {
          if (!draft || !revisionId) return;
          await actions.comment({
            revisionId,
            kind: 'pin',
            ...screen,
            x: draft.x,
            y: draft.y,
            selector: draft.selector,
            body,
          });
          setDraft(null);
        }}
      />

      <ApproveDialog
        open={approveOpen}
        onOpenChange={setApproveOpen}
        candidates={candidates}
        inView={state.revision}
        busy={busy === 'approve'}
        consequence={approval?.consequence}
        onApproveAndRun={
          approval?.onApproveAndRun
            ? (id) => {
                void approval
                  .onApproveAndRun?.(id)
                  .then(() => setApproveOpen(false))
                  .catch(() => {});
              }
            : undefined
        }
        onApprove={(id) => {
          void actions
            .approve({ revisionId: id })
            .then(() => setApproveOpen(false))
            .catch(() => {});
        }}
      />
    </div>
  );
}
