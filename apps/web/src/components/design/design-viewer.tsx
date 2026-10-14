'use client';

import {
  DESIGN_VIEWPORT_MAX_PX,
  DESIGN_VIEWPORT_MIN_PX,
  type DesignCommentRequest,
  type MockupPinMarker,
  type TaskDesignPatchRequest,
  type TaskDesignView,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { SidePanel } from '@andrewbehma/glass-ui/side-panel';
import { useMemo, useState } from 'react';
import {
  approveBlock,
  designWriteBlock,
  isOpen,
  pinMarkers,
  pinNumbers,
  reviseBlock,
} from '../../lib/design/comments';
import type { DesignBusy } from '../../lib/design/use-design';
import {
  revisionsOf,
  type ViewerChange,
  type ViewerState,
  variantsOf,
} from '../../lib/design/viewer-state';
import { ApproveDialog } from './approve-dialog';
import { CommentsPanel } from './comments-panel';
import { FrameBox } from './frame-box';
import { GeneratePanel } from './generate-panel';
import { MockupBanner } from './mockup-banner';
import { type FramePin, MockupFrame } from './mockup-frame';
import { PinComposer } from './pin-composer';
import { ViewerToolbar } from './viewer-toolbar';

export interface DesignViewerActions {
  patch: (body: TaskDesignPatchRequest) => Promise<unknown>;
  generate: () => Promise<unknown>;
  comment: (body: DesignCommentRequest) => Promise<unknown>;
  revise: () => Promise<unknown>;
  approve: (body: { revisionId: string }) => Promise<unknown>;
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
  onChange,
}: {
  projectId: string;
  design: TaskDesignView;
  state: ViewerState;
  canOperate: boolean;
  busy: DesignBusy | null;
  actions: DesignViewerActions;
  onChange: (change: ViewerChange) => void;
}) {
  const [pinMode, setPinMode] = useState(false);
  const [draft, setDraft] = useState<FramePin | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

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
        <Button
          variant="glass"
          disabled={reviseReason !== null || busy !== null}
          title={reviseReason ?? undefined}
          onClick={() => void actions.revise().catch(() => {})}
        >
          {busy === 'revise' ? 'Starting…' : `Revise design (${openCount})`}
        </Button>
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
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-4">
        <MockupBanner design={design} />
        {state.revision ? (
          <>
            <ViewerToolbar
              state={state}
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
            <FrameBox
              width={state.width}
              height={state.viewport.height}
              min={DESIGN_VIEWPORT_MIN_PX}
              max={DESIGN_VIEWPORT_MAX_PX}
              labels={{ resize: 'Resize the mockup' }}
              onWidthChange={(width) => onChange({ kind: 'width', width })}
            >
              <MockupFrame
                src={state.revision.htmlUrl}
                title={`Mockup: ${state.revision.title}`}
                theme={state.theme}
                pinMode={pinMode && writeBlock === null}
                pins={markers}
                onPin={(pin) => {
                  if (writeBlock === null) setDraft(pin);
                }}
              />
            </FrameBox>
          </>
        ) : (
          <GeneratePanel
            projectId={projectId}
            design={design}
            writeBlock={writeBlock}
            busy={busy === 'generate' || busy === 'patch'}
            onPatch={actions.patch}
            onGenerate={actions.generate}
          />
        )}
      </div>

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
