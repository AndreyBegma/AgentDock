'use client';

import type {
  AssistantAttachmentView,
  BoardView,
  ProjectDetail,
  SessionListResponse,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { Select } from '@andrewbehma/glass-ui/field';
import {
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
} from '@andrewbehma/glass-ui/menu';
import { Spinner } from '@andrewbehma/glass-ui/spinner';
import { FileText, Paperclip, SquareKanban, Terminal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

type Kind = 'card' | 'session';

interface Option {
  value: string;
  label: string;
}

/** Whether the project keeps session content here (ADR-0021); null while unknown. */
export function useSessionContent(projectId: string | null): boolean | null {
  const [state, setState] = useState<{ id: string; on: boolean } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api<ProjectDetail>(`/projects/${encodeURIComponent(projectId)}`).then(
      (detail) => {
        if (!cancelled) {
          setState({ id: projectId, on: detail.shipSessionContent === true });
        }
      },
      () => {
        if (!cancelled) setState({ id: projectId, on: false });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return state?.id === projectId ? state.on : null;
}

function useOptions(kind: Kind, projectId: string): Option[] | null {
  const [loaded, setLoaded] = useState<{
    key: string;
    options: Option[];
  } | null>(null);
  const key = `${kind}:${projectId}`;
  useEffect(() => {
    let cancelled = false;
    const done = (options: Option[]) => {
      if (!cancelled) setLoaded({ key, options });
    };
    const id = encodeURIComponent(projectId);
    if (kind === 'card') {
      api<BoardView>(`/projects/${id}/board`).then(
        (board) =>
          done(
            board.columns.flatMap((column) =>
              column.cards.map((card) => ({
                value: String(card.number),
                label: `${card.label} ${card.title}`,
              })),
            ),
          ),
        () => done([]),
      );
    } else {
      api<SessionListResponse>(`/sessions?projectId=${id}&limit=25`).then(
        (page) =>
          done(
            page.items.map((session) => ({
              value: session.id,
              label: session.title ?? session.slotName ?? session.externalId,
            })),
          ),
        () => done([]),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [kind, projectId, key]);
  return loaded?.key === key ? loaded.options : null;
}

/** Picks the card or the session to attach, inline under the chips. */
function AttachPicker({
  kind,
  projectId,
  onAttach,
  onClose,
}: {
  kind: Kind;
  projectId: string;
  onAttach: (value: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const options = useOptions(kind, projectId);
  const [busy, setBusy] = useState(false);
  const noun = kind === 'card' ? 'card' : 'session';
  return (
    <div className="flex items-center gap-2">
      {options === null ? (
        <Spinner size="sm" label={`Loading ${noun}s`} />
      ) : options.length === 0 ? (
        <span className="text-xs text-ink-3">
          No {noun}s to attach in this project.
        </span>
      ) : (
        <Select
          aria-label={`Attach a ${noun}`}
          disabled={busy}
          value=""
          className="min-w-0 flex-1"
          onChange={async (event) => {
            const value = event.target.value;
            if (!value) return;
            setBusy(true);
            const ok = await onAttach(value);
            setBusy(false);
            if (ok) onClose();
          }}
        >
          <option value="">Choose a {noun}…</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      )}
      <Button variant="ghost" size="sm" onClick={onClose}>
        Cancel
      </Button>
    </div>
  );
}

const ICON = { card: SquareKanban, session: Terminal, file: FileText } as const;

/** The pending attachments as chips, the attach menu, and its picker. */
export function AttachBar({
  attachments,
  projectId,
  onCard,
  onSession,
  onFile,
  onDetach,
}: {
  attachments: AssistantAttachmentView[];
  /** The conversation's project; null is Auto, which has no cards to list yet. */
  projectId: string | null;
  onCard: (projectId: string, cardNumber: number) => Promise<boolean>;
  onSession: (sessionId: string) => Promise<boolean>;
  onFile: (file: File) => Promise<boolean>;
  onDetach: (attachmentId: string) => void;
}) {
  const [picking, setPicking] = useState<Kind | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const sessionContent = useSessionContent(projectId);
  const needsProject = projectId === null;

  return (
    <div className="flex flex-col gap-2">
      {attachments.length > 0 ? (
        <ul
          className="flex flex-wrap gap-1.5"
          aria-label="Attached to the next message"
        >
          {attachments.map((attachment) => {
            const Icon = ICON[attachment.kind];
            return (
              <li key={attachment.id}>
                <Chip size="md" className="max-w-56 gap-1.5">
                  <Icon size={12} aria-hidden="true" />
                  <span className="truncate">{attachment.label}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.label}`}
                    onClick={() => onDetach(attachment.id)}
                    className="shrink-0 rounded-full hover:text-ink"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </Chip>
              </li>
            );
          })}
        </ul>
      ) : null}
      {picking && projectId ? (
        <AttachPicker
          kind={picking}
          projectId={projectId}
          onClose={() => setPicking(null)}
          onAttach={(value) =>
            picking === 'card'
              ? onCard(projectId, Number(value))
              : onSession(value)
          }
        />
      ) : null}
      <input
        ref={input}
        type="file"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) await onFile(file);
        }}
      />
      <MenuRoot>
        <MenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            icon
            aria-label="Attach to the next message"
            className="self-start"
          >
            <Paperclip size={14} aria-hidden="true" />
          </Button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem disabled={needsProject} onSelect={() => setPicking('card')}>
            <SquareKanban size={16} aria-hidden="true" />
            Card{needsProject ? ' — pick a project first' : ''}
          </MenuItem>
          {sessionContent ? (
            <MenuItem onSelect={() => setPicking('session')}>
              <Terminal size={16} aria-hidden="true" />
              Agent session
            </MenuItem>
          ) : null}
          <MenuItem
            disabled={needsProject}
            onSelect={() => input.current?.click()}
          >
            <FileText size={16} aria-hidden="true" />
            File{needsProject ? ' — pick a project first' : ''}
          </MenuItem>
        </MenuContent>
      </MenuRoot>
    </div>
  );
}
