'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { FloatingWindow } from '@andrewbehma/glass-ui/floating-window';
import { Launcher } from '@andrewbehma/glass-ui/launcher';
import type { ProjectSummary } from '@nautelle/shared';
import { MessageSquare, PanelLeft } from 'lucide-react';
import { useState } from 'react';
import { useAssistant } from '../../lib/assistant/use-assistant';
import { AttachBar } from './attach';
import { ConversationRail, UNTITLED } from './conversation-rail';
import { Pickers } from './pickers';
import { Thread } from './thread';

/** Where the window's position and size are remembered (per browser). */
export const WINDOW_STORAGE_KEY = 'agentdock.assistant.window';

const LABELS = {
  move: 'Move the window',
  minimize: 'Minimize',
  restore: 'Restore',
  maximize: 'Maximize',
  unmaximize: 'Restore size',
  close: 'Close',
};

/**
 * The assistant (ADR-0060) on every authenticated screen: the launcher, and
 * the draggable, resizable window it opens — a bottom sheet on a phone, where
 * the launcher rises above the capsule.
 */
export function Assistant({ projects }: { projects: ProjectSummary[] }) {
  const [open, setOpen] = useState(false);
  // Nothing is fetched until the person opens the assistant once.
  const [opened, setOpened] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const assistant = useAssistant(opened);
  const title = assistant.active?.title ?? UNTITLED;
  const choose = (next: Parameters<typeof assistant.choose>[0]) =>
    void assistant.choose(next);

  const toggle = () => {
    setOpened(true);
    setOpen((was) => !was);
  };

  return (
    <>
      <Launcher
        label="Assistant"
        icon={<MessageSquare size={20} aria-hidden="true" />}
        expanded={open}
        onClick={toggle}
      />
      <FloatingWindow
        open={open}
        onOpenChange={setOpen}
        title="Assistant"
        icon={<MessageSquare size={16} aria-hidden="true" />}
        labels={LABELS}
        storageKey={WINDOW_STORAGE_KEY}
        defaultWidth={820}
        defaultHeight={620}
        minWidth={360}
        minHeight={360}
        actions={
          <Button
            variant="ghost"
            size="sm"
            icon
            aria-label="Conversations"
            aria-pressed={railOpen}
            className="@3xl:hidden"
            onClick={() => setRailOpen((was) => !was)}
          >
            <PanelLeft size={14} aria-hidden="true" />
          </Button>
        }
      >
        <div className="@container flex h-full min-h-0 gap-3 p-3">
          <div
            className={`${railOpen ? 'flex' : 'hidden'} w-full shrink-0 flex-col @3xl:flex @3xl:w-56`}
          >
            <ConversationRail
              conversations={assistant.conversations}
              activeId={assistant.active?.id ?? null}
              onSelect={(id) => {
                assistant.select(id);
                setRailOpen(false);
              }}
              onNew={() => {
                assistant.select(null);
                setRailOpen(false);
              }}
              onRename={assistant.rename}
              onDelete={assistant.remove}
            />
          </div>
          <section
            aria-label={title}
            className={`${railOpen ? 'hidden @3xl:flex' : 'flex'} min-h-0 min-w-0 flex-1 flex-col gap-2`}
          >
            <Pickers
              choice={assistant.choice}
              models={assistant.models}
              projects={projects}
              disabled={assistant.live !== null}
              onChoose={choose}
            />
            {assistant.error ? (
              <Banner tone="danger" onDismiss={assistant.dismissError}>
                {assistant.error}
              </Banner>
            ) : null}
            <Thread
              messages={assistant.messages}
              live={assistant.live}
              notice={assistant.notice}
              projectId={assistant.choice.projectId}
              onSend={(text) => void assistant.send(text)}
              onDismissNotice={assistant.dismissNotice}
            />
            <AttachBar
              attachments={assistant.attachments}
              projectId={assistant.choice.projectId}
              onCard={assistant.attachCard}
              onSession={assistant.attachSession}
              onFile={assistant.uploadFile}
              onDetach={(id) => void assistant.detach(id)}
            />
          </section>
        </div>
      </FloatingWindow>
    </>
  );
}
