'use client';

import {
  TERMINAL_DEFAULT_SIZE,
  type TerminalTicketRequest,
  type TerminalTicketResponse,
  terminalServerFrameSchema,
} from '@agentdock/shared';
import type {
  TerminalCloseReason,
  TerminalMode,
} from '@agentdock/shared/protocol';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { ApiUnreachableError, api } from '../../lib/api';
import {
  AttachSupervisor,
  isTransientCloseCode,
} from '../../lib/terminal/attach';
import {
  CLOSE_REASON_LABEL,
  clampSize,
  describeCloseCode,
  describeRefusal,
  describeTicketError,
  inputFrames,
  type TerminalPhase,
  terminalSocketUrl,
} from '../../lib/terminal/format';

export type TerminalTarget =
  | { kind: 'slot'; slot: string }
  | { kind: 'orchestrator' }
  | { kind: 'skill_run'; runId: string }
  | { kind: 'manual'; sessionId: string }
  | { kind: 'card'; cardId: string };

/** The ticket body the API accepts for a `manual` target (`sessionId`). */
type TicketRequest = TerminalTicketRequest & { sessionId?: string };

export interface TerminalStatus {
  phase: TerminalPhase;
  /** A sentence for the person; set when the attach ended or was refused. */
  message?: string;
}

const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
  fallback;

/**
 * One attach: ticket → `/terminal` socket → xterm (spec 29 D5–D6). Remounting
 * (a new `key`) is a new attach; unmounting detaches, and the session keeps
 * running. Output arrives as binary frames and is written as raw bytes, so no
 * decoding can corrupt a multi-byte character split across frames.
 */
export function TerminalView({
  projectId,
  target,
  mode,
  onStatus,
}: {
  projectId: string;
  target: TerminalTarget;
  mode: TerminalMode;
  onStatus: (status: TerminalStatus) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const report = useRef(onStatus);
  report.current = onStatus;
  const slot = target.kind === 'slot' ? target.slot : undefined;
  const runId = target.kind === 'skill_run' ? target.runId : undefined;
  const sessionId = target.kind === 'manual' ? target.sessionId : undefined;
  const cardId = target.kind === 'card' ? target.cardId : undefined;
  const kind = target.kind;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let cleanup = () => {};

    const status = (next: TerminalStatus) => {
      if (!disposed) report.current(next);
    };

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed) return;

      const term = new Terminal({
        cursorBlink: mode === 'write',
        disableStdin: mode === 'read',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        scrollback: 5000,
        theme: {
          background: cssVar('--color-surface', '#101015'),
          foreground: cssVar('--color-ink', '#f2f2f6'),
          cursor: cssVar('--color-ink', '#f2f2f6'),
          selectionBackground: cssVar('--color-line-strong', '#ffffff24'),
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);
      fit.fit();
      const size = () =>
        clampSize(
          term.cols || TERMINAL_DEFAULT_SIZE.cols,
          term.rows || TERMINAL_DEFAULT_SIZE.rows,
        );

      const observer = new ResizeObserver(() => {
        fit.fit();
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'resize', ...size() }));
        }
      });
      observer.observe(element);

      cleanup = () => {
        observer.disconnect();
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'close' }));
        }
        socket?.close();
        term.dispose();
      };

      const request: TicketRequest = {
        kind,
        projectId,
        mode,
        ...(slot ? { slot } : {}),
        ...(runId ? { runId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(cardId ? { cardId } : {}),
      };

      if (mode === 'write') {
        term.onData((data) => {
          if (socket?.readyState !== WebSocket.OPEN) return;
          for (const bytes of inputFrames(data)) socket.send(bytes);
        });
        term.onBinary((data) => {
          if (socket?.readyState !== WebSocket.OPEN) return;
          socket.send(Uint8Array.from(data, (c) => c.charCodeAt(0)));
        });
      }

      // An attempt that is abandoned (timeout, retry) must not report late.
      let generation = 0;

      const attempt = async (n: number) => {
        const mine = generation;
        const stale = () => disposed || mine !== generation;
        if (n === 1) status({ phase: 'requesting' });
        let ticket: TerminalTicketResponse;
        try {
          ticket = await api<TerminalTicketResponse>('/terminal/tickets', {
            method: 'POST',
            body: request,
          });
        } catch (error) {
          if (stale()) return;
          if (error instanceof ApiUnreachableError) {
            supervisor.attemptFailed();
            return;
          }
          supervisor.dispose();
          status({ phase: 'refused', message: describeTicketError(error) });
          return;
        }
        if (stale()) return;

        if (n === 1) status({ phase: 'connecting' });
        const ws = new WebSocket(terminalSocketUrl(ticket.ticket, size()));
        ws.binaryType = 'arraybuffer';
        socket = ws;
        let attached = false;

        // The last word wins: a `closed` frame explains the close that follows.
        let outcome: TerminalStatus | undefined;

        ws.onmessage = (event) => {
          if (stale()) return;
          if (typeof event.data !== 'string') {
            term.write(new Uint8Array(event.data as ArrayBuffer));
            return;
          }
          let frame: unknown;
          try {
            frame = JSON.parse(event.data);
          } catch {
            return;
          }
          const parsed = terminalServerFrameSchema.safeParse(frame);
          if (!parsed.success) return;
          const value = parsed.data;
          if (value.type === 'attached') {
            attached = true;
            supervisor.attached();
            if (mode === 'write') term.focus();
          } else if (value.type === 'error') {
            outcome = {
              phase: 'refused',
              message: describeRefusal(value.code, value.heldBy),
            };
          } else {
            const reason: TerminalCloseReason = value.reason;
            outcome = { phase: 'ended', message: CLOSE_REASON_LABEL[reason] };
          }
        };
        ws.onclose = (event) => {
          if (stale()) return;
          if (!attached && !outcome && isTransientCloseCode(event.code)) {
            supervisor.attemptFailed();
            return;
          }
          supervisor.dispose();
          status(
            outcome ?? {
              phase: 'refused',
              message: describeCloseCode(event.code),
            },
          );
        };
      };

      const supervisor = new AttachSupervisor({
        start: (n) => void attempt(n),
        abort: () => {
          generation += 1;
          const old = socket;
          socket = undefined;
          if (old) {
            old.onclose = null;
            old.close();
          }
        },
        onState: (state) => {
          if (state.phase === 'attached') status({ phase: 'attached' });
          else if (state.phase === 'reconnecting') {
            status({
              phase: 'reconnecting',
              message: `Reconnecting… (attempt ${state.attempt})`,
            });
          } else if (state.phase === 'failed') {
            status({ phase: 'failed', message: 'Could not connect' });
          }
        },
      });
      const stopAttach = cleanup;
      cleanup = () => {
        generation += 1;
        supervisor.dispose();
        stopAttach();
      };
      supervisor.begin();
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [projectId, kind, slot, runId, sessionId, cardId, mode]);

  return (
    <div
      ref={host}
      role="application"
      aria-label={
        mode === 'write' ? 'Terminal, in control' : 'Terminal, read-only'
      }
      className="h-full min-h-64 w-full overflow-hidden rounded-control bg-surface p-2"
    />
  );
}
