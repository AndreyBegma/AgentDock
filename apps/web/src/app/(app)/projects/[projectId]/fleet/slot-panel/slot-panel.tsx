'use client';

import { projectRoleAtLeast } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { SidePanel } from '@andrewbehma/glass-ui/side-panel';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Tab, TabGroup, TabList, TabPanel } from '@andrewbehma/glass-ui/tabs';
import { X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { ScrollX } from '../../../../../../components/scroll-x/scroll-x';
import { TerminalSheet } from '../../../../../../components/terminal/terminal-sheet';
import type { useControl } from '../../../../../../lib/control/use-control';
import {
  isSlotNotFound,
  SLOT_STATUS_LABEL,
} from '../../../../../../lib/fleet/format';
import { slotHue } from '../../../../../../lib/hue';
import { slotSessionMessenger } from '../../../../../../lib/session-message/actions';
import {
  NODE_PILL_LABEL,
  NODE_PILL_STATUS,
  parseSlotTab,
  SLOT_PANEL_TABS,
  worktreeRunnerGate,
} from '../../../../../../lib/slot/format';
import { nodeOf } from '../../../../../../lib/slot/relations';
import {
  useSlotPanel,
  useSlotWorktree,
} from '../../../../../../lib/slot/use-slot-panel';
import { useWide } from '../../../../../../lib/slot/use-wide';
import { SLOT_PILL_STATUS } from '../../../../../../lib/status/pill';
import { useTerminalAvailable } from '../../../../../../lib/terminal/use-terminal-available';
import { useProjectDetail } from '../../use-project-detail';
import { ChatTab } from './chat-tab';
import { ContextTab } from './context-tab';
import { PaneTab } from './pane-tab';
import { Relations } from './relations';
import { SettingsTab } from './settings-tab';
import { StopSlot } from './stop-slot';
import { TestsTab } from './tests-tab';
import { FilesTab, WorktreeTab } from './worktree-tab';

export interface SlotPanelProps {
  projectId: string;
  /** The slot's name; the panel shows its latest run. */
  slot: string;
  /**
   * The page's control commands. One instance per page: each instance
   * announces the runs it did not send, so a second one would toast twice.
   */
  control: ReturnType<typeof useControl>;
  onClose: () => void;
  /** Opens another slot: the Sub-agents and Dependencies links. */
  onOpenSlot?: (slot: string) => void;
}

/**
 * The agent panel (#160): one slot's chat, brief, worktree, files, checks,
 * settings and live pane, with its sub-agents and dependencies. From `lg` it
 * is a resizable column — the caller puts it last in a flex row beside the
 * canvas; below `lg` it is a bottom sheet of its own.
 */
export function SlotPanel(props: SlotPanelProps) {
  const wide = useWide();
  // `key`: another slot starts on its own outbox and data. The tab is the
  // URL's, so moving between slots keeps the section in view.
  const body = <SlotPanelBody key={props.slot} {...props} />;

  if (wide === undefined) return null;
  if (wide) {
    return (
      <SidePanel
        storageKey="agentdock.fleet.slot-panel"
        aria-label={`Agent ${props.slot}`}
        labels={{
          resize: 'Resize the agent panel',
          expand: 'Show the agent panel',
        }}
        side="end"
        material="glass-strong"
        minWidth={360}
        maxWidth={760}
        defaultWidth={460}
        // The page scrolls, not the row: the panel holds its place under it,
        // like the rail, so the chat's composer is on screen without
        // scrolling the page to the panel's bottom (#213).
        className="sticky top-3 h-[calc(100dvh-1.5rem)] min-h-0"
      >
        {body}
      </SidePanel>
    );
  }
  return (
    <SheetRoot
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <SheetContent side="bottom" title={props.slot} hideTitle pad="none">
        {body}
      </SheetContent>
    </SheetRoot>
  );
}

function Header({
  slot,
  issue,
  pill,
  issueTitle,
  actions,
  onClose,
}: {
  slot: string;
  issue: number | null;
  pill: ReactNode;
  issueTitle: string | null;
  actions: ReactNode;
  onClose: () => void;
}) {
  return (
    <header className="flex flex-col gap-2 border-b border-line px-4 pt-4 pb-3">
      <div className="flex items-center gap-2">
        <Badge dot hue={slotHue(slot)} aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
          {slot}
        </h2>
        {pill}
        <Button
          variant="ghost"
          size="sm"
          icon
          aria-label={`Close ${slot}`}
          onClick={onClose}
        >
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-8 items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-sm text-ink-2">
          {issue !== null ? `#${issue}` : ''}
          {issue !== null && issueTitle ? ' · ' : ''}
          {issueTitle ?? ''}
        </p>
        {actions}
      </div>
    </header>
  );
}

function SlotPanelBody({
  projectId,
  slot,
  control,
  onClose,
  onOpenSlot,
}: SlotPanelProps) {
  const project = useProjectDetail(projectId).data;
  // The role only decides which buttons are drawn; the API checks it.
  const role = project?.role ?? 'viewer';
  const isAdmin = role === 'admin';
  const canOperate = projectRoleAtLeast(role, 'operator');
  const canAttach = useTerminalAvailable(project?.runnerId, isAdmin);

  const { detail, conversation, graph, settings, detailVersion } = useSlotPanel(
    projectId,
    slot,
  );
  // The tab is in the URL (`?tab=files`), so a link or a reload lands on it.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseSlotTab(searchParams.get('tab'));
  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'chat') params.delete('tab');
    else params.set('tab', next);
    const search = params.toString().replace(/%2C/g, ',');
    router.replace(`${pathname}${search ? `?${search}` : ''}`, {
      scroll: false,
    });
  };
  const [attaching, setAttaching] = useState(false);
  const run = detail.data;
  const ended = run?.status === 'ended';
  // An ended slot's worktree is gone: neither tab asks the runner (#213).
  // Each tab has its own request, so Files never shows Worktree's state.
  const live = run !== undefined && !ended;
  // #233: a runner that advertised it cannot read worktrees is not asked.
  const runnerGate = worktreeRunnerGate(project);
  const asks = live && runnerGate === null;
  const worktree = useSlotWorktree(
    projectId,
    slot,
    asks && tab === 'worktree',
    detailVersion,
  );
  const files = useSlotWorktree(
    projectId,
    slot,
    asks && tab === 'files',
    detailVersion,
  );

  const node = nodeOf(graph.data, slot);
  const pill = run ? (
    <StatusPill
      status={SLOT_PILL_STATUS[run.status]}
      label={SLOT_STATUS_LABEL[run.status]}
    />
  ) : node ? (
    <StatusPill
      status={NODE_PILL_STATUS[node.pill]}
      label={node.kind === 'planned' ? 'planned' : NODE_PILL_LABEL[node.pill]}
    />
  ) : null;

  const writeReason = !canOperate
    ? 'Only operators and admins can message a worker.'
    : ended
      ? 'This slot has ended; there is no worker to message.'
      : undefined;

  const relations = (
    <Relations graph={graph.data} slot={slot} onOpenSlot={onOpenSlot} />
  );

  let content: ReactNode;
  if (run === undefined && detail.error !== null) {
    content = isSlotNotFound(detail.error) ? (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-2">
          {node?.kind === 'planned'
            ? 'Not dispatched yet. It is on the issue’s parallel plan; the orchestrator dispatches it when what it waits for is done.'
            : 'That slot no longer exists.'}
        </p>
        {relations}
      </div>
    ) : (
      <SectionUnavailable
        title="The slot could not be loaded"
        stillWorks="The canvas is still current."
        action={
          <Button variant="glass" size="sm" onClick={detail.retry}>
            Try again
          </Button>
        }
      />
    );
  } else if (run === undefined) {
    content = <Skeleton className="h-96 w-full" />;
  } else {
    content = (
      <div className="flex flex-col gap-5">
        <TabGroup value={tab} onValueChange={setTab}>
          <div className="flex flex-col">
            {/* Seven tabs outgrow the 426 px column: they keep their width
              and scroll, with a fade at the edge that has more (#213). */}
            <ScrollX edgeClassName="from-surface">
              <TabList aria-label="Agent sections" className="w-max min-w-full">
                {SLOT_PANEL_TABS.map(({ id, label }) => (
                  <Tab
                    key={id}
                    value={id}
                    className="flex-none whitespace-nowrap"
                  >
                    {label}
                  </Tab>
                ))}
              </TabList>
            </ScrollX>
            <TabPanel value="chat" className="pt-5">
              <ChatTab
                slot={slot}
                conversation={conversation}
                control={control}
                writeReason={writeReason}
                sessionSend={
                  canOperate ? slotSessionMessenger(projectId, slot) : undefined
                }
              />
            </TabPanel>
            <TabPanel value="context" className="pt-5">
              <ContextTab slot={run} />
            </TabPanel>
            <TabPanel value="worktree" className="pt-5">
              <WorktreeTab
                worktree={worktree}
                ended={ended}
                runnerGate={runnerGate}
              />
            </TabPanel>
            <TabPanel value="files" className="pt-5">
              <FilesTab files={files} ended={ended} runnerGate={runnerGate} />
            </TabPanel>
            <TabPanel value="tests" className="pt-5">
              <TestsTab slot={run} conversation={conversation.data} />
            </TabPanel>
            <TabPanel value="settings" className="pt-5">
              <SettingsTab
                projectId={projectId}
                slot={run}
                settings={settings}
              />
            </TabPanel>
            <TabPanel value="pane" className="pt-5">
              <PaneTab
                projectId={projectId}
                slot={slot}
                ended={ended}
                onAttach={canAttach ? () => setAttaching(true) : undefined}
              />
            </TabPanel>
          </div>
        </TabGroup>
        {relations}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header
        slot={slot}
        issue={run?.issue ?? node?.issue ?? null}
        pill={pill}
        issueTitle={node?.issueTitle ?? null}
        onClose={onClose}
        actions={
          canOperate && run && !ended ? (
            <StopSlot slot={slot} control={control} />
          ) : null
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{content}</div>
      <TerminalSheet
        projectId={projectId}
        target={attaching ? { kind: 'slot', slot } : undefined}
        title={slot}
        onClose={() => setAttaching(false)}
        message={
          canOperate
            ? { send: slotSessionMessenger(projectId, slot) }
            : undefined
        }
      />
    </div>
  );
}
