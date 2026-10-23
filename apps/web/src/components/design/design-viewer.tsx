'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { SidePanel } from '@andrewbehma/glass-ui/side-panel';
import { TabGroup, TabPanel } from '@andrewbehma/glass-ui/tabs';
import type {
  CardDesignLaunchRequest,
  CardStackRef,
  DesignCommentRequest,
  DesignCommentView,
  DesignTheme,
  MockupPinMarker,
  TaskDesignPatchRequest,
  TaskDesignView,
  ViewportPreset,
} from '@nautelle/shared';
import {
  Crosshair,
  MessageSquare,
  MessageSquarePlus,
  Monitor,
  MousePointer2,
  Smartphone,
  Tablet,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LaunchCard } from '../../lib/board/launch';
import type { Point } from '../../lib/canvas/geometry';
import {
  approveBlock,
  designWriteBlock,
  framesWithOpenPins,
  isOpen,
  openCommentsByFrame,
  pinMarkers,
  pinNumbers,
  reviseBlock,
  stackDrawBlock,
} from '../../lib/design/comments';
import { framePath } from '../../lib/design/frames';
import { stackDesignHref } from '../../lib/design/href';
import { isStarting } from '../../lib/design/progress';
import { compareColumns } from '../../lib/design/templates';
import type { DesignBusy } from '../../lib/design/use-design';
import {
  revisionsOf,
  type ViewerChange,
  type ViewerState,
  variantsOf,
} from '../../lib/design/viewer-state';
import type { Zoom } from '../../lib/design/zoom';
import { useWide } from '../../lib/slot/use-wide';
import { LaunchPopover } from '../board/launch-popover';
import {
  type CanvasFocus,
  type CanvasFrame,
  FrameCanvas,
  useFrameCanvas,
} from '../canvas/frame-canvas';
import { ApproveDialog } from './approve-dialog';
import { CommentsPanel } from './comments-panel';
import { CompareGrid } from './compare-grid';
import { ConformanceBadge } from './conformance-badge';
import { DesignFailure } from './design-failure';
import { DesignProgress, DesignStarting } from './design-progress';
import { FrameTabs, frameKey } from './frame-tabs';
import { GeneratePanel } from './generate-panel';
import { MockupBanner } from './mockup-banner';
import { type FramePin, MockupFrame } from './mockup-frame';
import { PinComposer } from './pin-composer';
import { ViewControls, ViewerToolbar } from './viewer-toolbar';

export interface DesignViewerActions {
  patch: (body: TaskDesignPatchRequest) => Promise<unknown>;
  generate: (body?: CardDesignLaunchRequest) => Promise<unknown>;
  comment: (body: DesignCommentRequest) => Promise<unknown>;
  revise: (body?: CardDesignLaunchRequest) => Promise<unknown>;
  approve: (body: { revisionId: string }) => Promise<unknown>;
  /** #833 D7: the repair turn by hand. */
  complete: () => Promise<unknown>;
  stop: () => Promise<unknown>;
}

/** The canvas's view, held here while a gesture runs and written to the URL after. */
interface CanvasViewState {
  zoom: Zoom;
  pan: Point;
}

/**
 * How long the canvas rests before its zoom and pan go into the URL: a
 * gesture reports many views, and the link needs only the last.
 */
const VIEW_WRITE_MS = 300;

/** A pin being written: where it was dropped, at what scale, on which device. */
type PinDraft = FramePin & { zoom: number; device: string };

/** A device's icon on its label, by its width. */
function DeviceIcon({ width }: { width: number }) {
  if (width < 600) return <Smartphone aria-hidden="true" />;
  if (width < 1100) return <Tablet aria-hidden="true" />;
  return <Monitor aria-hidden="true" />;
}

/**
 * One device of the frame in view (#886): the mockup at the device's size,
 * its pins, and the canvas's zoom for a wheel the iframe cannot let bubble
 * and for the touch-size markers.
 */
function DeviceFrame({
  src,
  title,
  theme,
  pinMode,
  pins,
  phone,
  onPin,
  onPinOpen,
}: {
  src: string;
  title: string;
  theme: DesignTheme;
  pinMode: boolean;
  pins: MockupPinMarker[];
  phone: boolean;
  onPin: (pin: FramePin, scale: number) => void;
  onPinOpen: () => void;
}) {
  const canvas = useFrameCanvas();
  return (
    <MockupFrame
      src={src}
      title={title}
      theme={theme}
      pinMode={pinMode}
      pins={pins}
      onWheel={(deltaY) => canvas.zoomByWheel(deltaY)}
      touchScale={phone ? canvas.scale : undefined}
      onPinOpen={onPinOpen}
      onPin={(pin) => onPin(pin, canvas.scale)}
    />
  );
}

/**
 * Where selecting a comment puts the canvas: its pin on its device, or the
 * middle of the device it names, or of the device in view.
 */
export function commentFocus(
  comment: DesignCommentView,
  devices: readonly ViewportPreset[],
  inView: ViewportPreset,
): CanvasFocus {
  const device = devices.find((d) => d.name === comment.viewport);
  const at = device ?? inView;
  if (device && comment.x !== null && comment.y !== null) {
    // A pin below the fold sits in the document, past the device's height:
    // the bottom edge is as near as the canvas can show it.
    return {
      frameId: at.name,
      point: {
        x: Math.min(Math.max(comment.x, 0), at.width),
        y: Math.min(Math.max(comment.y, 0), at.height),
      },
    };
  }
  return { frameId: at.name, point: { x: at.width / 2, y: at.height / 2 } };
}

/**
 * The design viewer's workspace (spec 223 D9–D11, "UI"; #886): the frames
 * of the revision as tabs, each a canvas with the frame drawn once per
 * device, and the right panel with the comments, **Revise design** and
 * **Approve**. The page owns loading and the URL; this owns the pin draft,
 * the dialogs and the canvas's view between two URL writes.
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
  stack,
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
  /**
   * A card's stack (#527, ADR-0044 §5): while its design is not approved,
   * Generate and Revise wait for it. A card in no stack leaves it out.
   */
  stack?: CardStackRef | null;
  onChange: (change: ViewerChange) => void;
}) {
  // Below `lg` (C-244): the touch layout, with the review controls moved off the toolbar.
  const phone = useWide() === false;
  // The Comment tool (C): a click on a device drops a pin.
  const [pinMode, setPinMode] = useState(false);
  const [draft, setDraft] = useState<PinDraft | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  // #833 D11: the same frame of every variant side by side.
  const [compare, setCompare] = useState(false);
  // #886: the comment shown on the canvas, and where the canvas goes for it.
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<CanvasFocus | null>(null);

  // The canvas reports zoom and pan one after the other, many times a
  // gesture; they live here and reach the URL together once it rests. Every
  // tab shows the same devices, so one view serves them all.
  const [view, setView] = useState<CanvasViewState>({
    zoom: state.zoom,
    pan: state.pan,
  });
  const live = useRef({ view, onChange });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    live.current.onChange = onChange;
  });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const changeView = useCallback((next: Partial<CanvasViewState>) => {
    const merged = { ...live.current.view, ...next };
    live.current.view = merged;
    setView(merged);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      live.current.onChange({ kind: 'view', ...live.current.view });
    }, VIEW_WRITE_MS);
  }, []);
  const onZoomChange = useCallback(
    (zoom: Zoom) => changeView({ zoom }),
    [changeView],
  );
  const onPanChange = useCallback(
    (pan: Point) => changeView({ pan }),
    [changeView],
  );
  const onFocused = useCallback(() => setFocus(null), []);

  const writeBlock = designWriteBlock(design, canOperate);
  const stackBlock = stackDrawBlock(stack);
  const reviseReason = reviseBlock(design, canOperate, stackBlock);
  const approveReason = approveBlock(design, canOperate);
  const revisionId = state.revision?.id ?? null;
  const frames = state.revision?.frames ?? [];
  const pinning = pinMode && writeBlock === null;
  // A screen comment names the device in view: the one a pin or a selected
  // comment last put there, or the first.
  const screen = { viewport: state.device.name, theme: state.theme };
  // #441: a comment's frame is named in its own revision.
  const frameNames = useMemo(
    () =>
      new Map(design.revisions.map((r) => [r.id, r.frames.map((f) => f.name)])),
    [design.revisions],
  );
  const frameNameOf = (c: DesignCommentView): string | null =>
    frameNames.get(c.revisionId)?.[c.frame] ?? null;
  const selectFrame = (next: number) => {
    if (next === state.frame) return;
    // A pin draft belongs to the frame it was placed on.
    setDraft(null);
    onChange({ kind: 'frame', frame: next });
  };
  const setTool = (comment: boolean) => {
    setPinMode(comment);
    if (!comment) setDraft(null);
  };
  const selectComment = (c: DesignCommentView) => {
    const device = state.devices.find((d) => d.name === c.viewport);
    setSelected(c.id);
    setDraft(null);
    setCompare(false);
    setSheetOpen(false);
    onChange({
      kind: 'place',
      revisionId: c.revisionId,
      frame: c.frame,
      device: device?.name ?? null,
      theme: c.theme,
    });
    setFocus(commentFocus(c, state.devices, state.device));
  };
  const variants = variantsOf(design.revisions);
  const comparing = compare && variants.length > 1;
  const templateKey = state.revision?.templateKey ?? null;
  const templateName =
    templateKey === null
      ? null
      : templateKey === design.template.key
        ? design.template.name
        : templateKey;
  const completeReason =
    writeBlock ??
    (design.progress || isStarting(design) || busy !== null
      ? 'A design turn is running.'
      : null);
  const openCount = design.comments.filter(isOpen).length;

  const draftNumber = pinNumbers(design.comments, revisionId).size + 1;
  const markersOf = (device: string): MockupPinMarker[] => {
    const saved = pinMarkers(
      design.comments,
      revisionId,
      device,
      state.theme,
      state.frame,
    );
    return draft?.device === device
      ? [...saved, { n: draftNumber, x: draft.x, y: draft.y }]
      : saved;
  };

  const canvasFrames = (htmlUrl: string, frameName: string): CanvasFrame[] =>
    state.devices.map((device) => ({
      id: device.name,
      name: device.name,
      width: device.width,
      height: device.height,
      icon: <DeviceIcon width={device.width} />,
      active: device.name === state.device.name,
      content: (
        <DeviceFrame
          src={htmlUrl}
          title={`Mockup: ${state.revision?.title} · ${frameName} · ${device.name}`}
          theme={state.theme}
          pinMode={pinning}
          pins={markersOf(device.name)}
          phone={phone}
          onPinOpen={() => setSheetOpen(true)}
          onPin={(pin, scale) => {
            if (!pinning) return;
            setDraft({ ...pin, zoom: scale, device: device.name });
            if (device.name !== state.device.name) {
              onChange({ kind: 'device', device: device.name });
            }
          }}
        />
      ),
    }));

  const onStageKeyDown = (event: React.KeyboardEvent) => {
    if (!state.revision || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    // A field keeps its own keys (a pin's comment, the theme).
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) {
      return;
    }
    // #441: `[` and `]` step through the frames.
    const nextFrame = frameKey(event, state.frame, frames.length);
    if (nextFrame !== null) {
      event.preventDefault();
      selectFrame(nextFrame);
      return;
    }
    // #886: V moves, C comments, Escape puts the Comment tool down.
    const key = event.key.toLowerCase();
    if (key === 'v' || (key === 'escape' && pinMode)) {
      event.preventDefault();
      setTool(false);
    } else if (key === 'c' && writeBlock === null) {
      event.preventDefault();
      setTool(true);
    }
  };

  const tools = (
    <>
      <Button
        icon
        variant="ghost"
        aria-label="Move (V)"
        title="Move (V)"
        aria-pressed={!pinMode}
        onClick={() => setTool(false)}
      >
        <MousePointer2 aria-hidden="true" className="size-3.5" />
      </Button>
      <Button
        icon
        variant="ghost"
        aria-label="Comment (C)"
        title={writeBlock ?? 'Comment (C): click a device to drop a pin'}
        aria-pressed={pinning}
        disabled={writeBlock !== null}
        onClick={() => setTool(!pinMode)}
      >
        <MessageSquarePlus aria-hidden="true" className="size-3.5" />
      </Button>
    </>
  );

  const panel = (
    <div className="flex flex-col gap-4 p-4">
      {phone && state.revision ? (
        <section aria-label="View" className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-ink-3">View</h3>
          <div className="flex flex-wrap items-center gap-2">
            <ViewControls
              touch
              state={state}
              variants={variants}
              revisions={revisionsOf(design.revisions, state.variant)}
              onChange={onChange}
            />
          </div>
        </section>
      ) : null}
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
      <p className="text-xs text-ink-3">
        Revise redraws the whole revision and passes every open comment with its
        frame's name. Approve covers every frame of the variant.
      </p>
      {state.revision ? (
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">{state.revision.title}</h2>
          <p className="text-sm whitespace-pre-wrap text-ink-2">
            {state.revision.rationale}
          </p>
        </div>
      ) : null}
      {state.revision ? (
        <section
          aria-label="Publishes on approve"
          className="flex flex-col gap-2 rounded-md border border-line p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold">Publishes on approve</h3>
            <Badge
              label={`${frames.length} file${frames.length === 1 ? '' : 's'}`}
            />
          </div>
          <ul className="flex flex-col gap-1">
            {frames.map((f) => (
              <li
                key={f.position}
                className="flex items-baseline justify-between gap-2 text-xs"
              >
                <span className="truncate font-mono">
                  {framePath(state.variant, f)}
                </span>
                <span className="shrink-0 text-ink-3">{f.name}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-3">
            Committed with the work, and listed under{' '}
            <span className="font-mono">## Design</span> in its prompt.
          </p>
        </section>
      ) : null}
      <CommentsPanel
        projectId={projectId}
        owner={design.owner}
        canOperate={canOperate}
        comments={design.comments}
        revisionId={revisionId}
        frames={frames}
        frame={state.frame}
        frameNameOf={frameNameOf}
        screen={screen}
        devices={state.devices.map((d) => d.name)}
        onDevice={(device) => onChange({ kind: 'device', device })}
        selected={selected}
        onSelect={selectComment}
        writeBlock={writeBlock}
        busy={busy === 'comment'}
        onComment={async (body) => {
          if (!revisionId) return;
          await actions.comment({ ...body, revisionId, frame: state.frame });
        }}
      />
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1">
      {/* The canvas and the tabs inside take focus; this adds the tab and tool keys to theirs. */}
      <section
        aria-label="Mockup stage"
        onKeyDown={onStageKeyDown}
        className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-4"
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
        ) : isStarting(design) ? (
          <DesignStarting
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
          <TabGroup
            value={String(state.frame)}
            onValueChange={(value) => selectFrame(Number(value))}
          >
            <FrameTabs
              frames={frames}
              frame={state.frame}
              variant={state.variant}
              comments={openCommentsByFrame(design.comments, revisionId)}
              pinned={framesWithOpenPins(design.comments, revisionId)}
              onFrame={selectFrame}
              templateName={templateName}
              compare={
                variants.length > 1
                  ? { on: comparing, onToggle: () => setCompare(!compare) }
                  : undefined
              }
              tools={
                phone ? undefined : (
                  <ViewerToolbar
                    state={state}
                    variants={variants}
                    revisions={revisionsOf(design.revisions, state.variant)}
                    onChange={onChange}
                  />
                )
              }
            />
            <ConformanceBadge
              conformance={state.revision.conformance}
              canComplete={canOperate}
              completing={busy === 'complete'}
              disabledReason={completeReason}
              onComplete={() => void actions.complete().catch(() => {})}
            />
            {comparing ? (
              <CompareGrid
                columns={compareColumns(
                  design.revisions,
                  variants,
                  state.frame,
                )}
                preset={state.device}
                theme={state.theme}
                position={state.frame}
                variantInView={state.variant}
                onPick={(variant) => {
                  setCompare(false);
                  onChange({ kind: 'variant', variant });
                }}
              />
            ) : null}
            {/* #441: one panel per frame; only the one in view renders its canvas. */}
            {(comparing ? [] : frames).map((f) => (
              <TabPanel
                key={f.position}
                value={String(f.position)}
                className="flex min-h-0 flex-1 flex-col gap-2"
              >
                <FrameCanvas
                  label={`${f.name} on every device`}
                  className="min-h-[420px] flex-1"
                  frames={canvasFrames(f.htmlUrl, f.name)}
                  zoom={view.zoom}
                  pan={view.pan}
                  onZoomChange={onZoomChange}
                  onPanChange={onPanChange}
                  tools={tools}
                  focus={focus}
                  onFocused={onFocused}
                />
                <p role="status" className="shrink-0 text-xs text-ink-3">
                  {pinning
                    ? `${phone ? 'Tap' : 'Click'} a device to place a pin.${phone ? '' : ' Esc to stop.'}`
                    : phone
                      ? null
                      : 'C, then click a device to pin a comment · [ and ] switch tabs'}
                </p>
              </TabPanel>
            ))}
          </TabGroup>
        ) : design.progress || isStarting(design) ? null : (
          <GeneratePanel
            projectId={projectId}
            design={design}
            writeBlock={writeBlock}
            stackBlock={stackBlock}
            stackHref={
              stack ? stackDesignHref(projectId, stack.number) : undefined
            }
            busy={busy === 'generate' || busy === 'patch'}
            onPatch={actions.patch}
            onGenerate={actions.generate}
            launch={launch}
          />
        )}
        {phone && state.revision ? (
          <div
            role="toolbar"
            aria-label="Review actions"
            className="glass sticky bottom-0 z-10 mt-auto flex shrink-0 gap-2 rounded-sheet p-2"
          >
            <Button
              variant="glass"
              className="h-11 px-3 text-sm"
              aria-pressed={pinMode}
              disabled={writeBlock !== null}
              title={writeBlock ?? undefined}
              onClick={() => setTool(!pinMode)}
            >
              <Crosshair aria-hidden="true" className="size-4" />
              Pin
            </Button>
            <Button
              variant="glass"
              className="h-11 px-3 text-sm"
              onClick={() => setSheetOpen(true)}
            >
              <MessageSquare aria-hidden="true" className="size-4" />
              Comments
              {openCount > 0 ? <Badge count={openCount} /> : null}
            </Button>
            <Button
              variant="solid"
              className="h-11 flex-1 text-sm"
              disabled={approveReason !== null || busy !== null}
              title={approveReason ?? undefined}
              onClick={() => setApproveOpen(true)}
            >
              Approve
            </Button>
          </div>
        ) : null}
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
        zoom={draft?.zoom ?? 1}
        number={draftNumber}
        screen={`${draft?.device ?? screen.viewport} · ${screen.theme}`}
        busy={busy === 'comment'}
        phone={phone}
        frameName={frames[state.frame]?.name ?? null}
        onCancel={() => setDraft(null)}
        onSave={async (body) => {
          if (!draft || !revisionId) return;
          // The pin names the device it was dropped on, as `viewport`.
          await actions.comment({
            revisionId,
            frame: state.frame,
            kind: 'pin',
            viewport: draft.device,
            theme: state.theme,
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
        candidates={candidates(design)}
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

/** What Approve offers: the latest revision of every variant. */
const candidates = (design: TaskDesignView) =>
  variantsOf(design.revisions).flatMap((v) => {
    const latest = revisionsOf(design.revisions, v)[0];
    return latest ? [latest] : [];
  });
