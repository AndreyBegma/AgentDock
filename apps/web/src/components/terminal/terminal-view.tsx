'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import {
  TERMINAL_DEFAULT_SIZE,
  type TerminalTicketRequest,
  type TerminalTicketResponse,
  terminalServerFrameSchema,
} from '@nautelle/shared';
import type {
  TerminalCloseReason,
  TerminalMode,
} from '@nautelle/shared/protocol';
import type { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
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
import {
  HISTORY_WAIT_MS,
  HistoryController,
  type HistoryView,
  historyText,
  Swipe,
  TouchScroll,
  wheelLines,
} from '../../lib/terminal/history';

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

/** The viewport shows the newest line of the buffer. */
const atBottom = (term: XTerm) =>
  term.buffer.active.viewportY >= term.buffer.active.baseY;

/**
 * The 16 ANSI colours from glass-ui tokens: the hue ramp for the colours, `ink`
 * levels for the greys. Muted on purpose — diffs and highlights sit on the
 * glass sheet instead of shouting over it. Read at attach time so a theme
 * switch is picked up by the next attach.
 */
function terminalTheme() {
  const ink = cssVar('--color-ink', '#f2f2f6');
  const background = cssVar('--color-ground', '#09090c');
  return {
    background,
    foreground: ink,
    cursor: ink,
    cursorAccent: background,
    selectionBackground: cssVar('--color-line-strong', '#ffffff24'),
    black: cssVar('--color-raised', '#17171e'),
    red: cssVar('--color-hue-6', '#f0606e'),
    green: cssVar('--color-hue-2', '#2fbf94'),
    yellow: cssVar('--color-hue-4', '#e69f00'),
    blue: cssVar('--color-hue-1', '#5b9cf6'),
    magenta: cssVar('--color-hue-8', '#cc79a7'),
    cyan: cssVar('--color-info', '#5fb4f0'),
    white: cssVar('--color-ink-2', '#b4b4b8'),
    brightBlack: cssVar('--color-ink-3', '#6c6c70'),
    brightRed: cssVar('--color-hue-6-ink', '#ff9da5'),
    brightGreen: cssVar('--color-hue-2-ink', '#7ee0c0'),
    brightYellow: cssVar('--color-hue-4-ink', '#f5c25c'),
    brightBlue: cssVar('--color-hue-1-ink', '#a4c8ff'),
    brightMagenta: cssVar('--color-hue-8-ink', '#efabd1'),
    brightCyan: cssVar('--color-hue-7-ink', '#cbbcff'),
    brightWhite: ink,
  };
}

/**
 * One attach: ticket → `/terminal` socket → xterm (spec 29 D5–D6). Remounting
 * (a new `key`) is a new attach; unmounting detaches, and the session keeps
 * running. Output arrives as binary frames and is written as raw bytes, so no
 * decoding can corrupt a multi-byte character split across frames.
 *
 * Scrollback (#522): tmux redraws the whole screen, so the live xterm has no
 * scrollback of its own. Scrolling up — the wheel, or a swipe down — asks the
 * runner once for the pane's history and shows it in a second, read-only
 * xterm over the live one, while output keeps landing in the live one below.
 * Scrolling back to the bottom or **Back to live** returns. Wheel and touch on
 * the live view never reach xterm, which would turn them into arrow keys for
 * the PTY, and keystrokes are not sent while the history is open.
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
  const historyHost = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<HistoryView>('live');
  const backToLive = useRef(() => {});
  const report = useRef(onStatus);
  report.current = onStatus;
  const slot = target.kind === 'slot' ? target.slot : undefined;
  const runId = target.kind === 'skill_run' ? target.runId : undefined;
  const sessionId = target.kind === 'manual' ? target.sessionId : undefined;
  const cardId = target.kind === 'card' ? target.cardId : undefined;
  const kind = target.kind;

  useEffect(() => {
    const element = host.current;
    const historyElement = historyHost.current;
    if (!element || !historyElement) return;
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
        lineHeight: 1.2,
        scrollback: 5000,
        theme: terminalTheme(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);
      fit.fit();
      const theme = term.options.theme;
      const size = () =>
        clampSize(
          term.cols || TERMINAL_DEFAULT_SIZE.cols,
          term.rows || TERMINAL_DEFAULT_SIZE.rows,
        );

      // History (#522): a read-only xterm, made when an answer arrives.
      let past: { term: XTerm; fit: { fit(): void } } | undefined;
      let waiting: ReturnType<typeof setTimeout> | undefined;
      const controller = new HistoryController((view) => {
        if (!disposed) setHistory(view);
      });
      const closePast = () => {
        clearTimeout(waiting);
        past?.term.dispose();
        past = undefined;
        controller.live();
      };
      backToLive.current = () => {
        closePast();
        if (mode === 'write') term.focus();
      };
      const askHistory = () => {
        if (socket?.readyState !== WebSocket.OPEN) return;
        if (!controller.scrolledUp()) return;
        term.blur();
        socket.send(JSON.stringify({ type: 'history' }));
        waiting = setTimeout(() => controller.live(), HISTORY_WAIT_MS);
      };
      const showPast = (lines: string[]) => {
        clearTimeout(waiting);
        const view = new Terminal({
          disableStdin: true,
          cursorBlink: false,
          cursorInactiveStyle: 'none',
          fontFamily: term.options.fontFamily,
          fontSize: term.options.fontSize,
          lineHeight: term.options.lineHeight,
          scrollback: lines.length + 200,
          theme,
        });
        const viewFit = new FitAddon();
        view.loadAddon(viewFit);
        view.open(historyElement);
        viewFit.fit();
        past = { term: view, fit: viewFit };
        view.write(historyText(lines), () => {
          if (past?.term !== view) return;
          // One step up, so the scroll that asked shows earlier output.
          view.scrollLines(-Math.max(1, Math.floor(view.rows / 2)));
        });
      };

      // Live view: wheel up and a swipe down ask; neither reaches xterm.
      const liveSwipe = new Swipe();
      const onLiveWheel = (event: WheelEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.deltaY < 0) askHistory();
      };
      const onLiveTouchStart = (event: TouchEvent) => {
        liveSwipe.start(event.touches[0]?.clientY ?? 0);
      };
      const onLiveTouchMove = (event: TouchEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (liveSwipe.swipe(event.touches[0]?.clientY ?? 0) === 'down') {
          liveSwipe.end();
          askHistory();
        }
      };
      const onLiveTouchEnd = () => liveSwipe.end();
      // History view: scrolled here, not by xterm; down to the bottom goes
      // back to live.
      const cellPx = () =>
        past ? historyElement.clientHeight / Math.max(1, past.term.rows) : 1;
      /** Scrolls `lines` (positive: towards the live end); at the bottom, returns. */
      const scrollPast = (lines: number) => {
        if (!past || lines === 0) return;
        if (lines > 0 && atBottom(past.term)) return closePast();
        past.term.scrollLines(lines);
        if (lines > 0 && atBottom(past.term)) closePast();
      };
      const pastTouch = new TouchScroll();
      const onPastWheel = (event: WheelEvent) => {
        event.preventDefault();
        event.stopPropagation();
        scrollPast(
          wheelLines(
            event.deltaY,
            event.deltaMode,
            cellPx(),
            past?.term.rows ?? 1,
          ),
        );
      };
      const onPastTouchStart = (event: TouchEvent) => {
        pastTouch.start(event.touches[0]?.clientY ?? 0);
      };
      const onPastTouchMove = (event: TouchEvent) => {
        event.preventDefault();
        event.stopPropagation();
        // A finger moving down brings earlier output: scroll up.
        scrollPast(-pastTouch.lines(event.touches[0]?.clientY ?? 0, cellPx()));
      };
      const onPastTouchEnd = () => pastTouch.end();
      const capture = { capture: true, passive: false } as const;
      element.addEventListener('wheel', onLiveWheel, capture);
      element.addEventListener('touchstart', onLiveTouchStart, capture);
      element.addEventListener('touchmove', onLiveTouchMove, capture);
      element.addEventListener('touchend', onLiveTouchEnd, capture);
      historyElement.addEventListener('wheel', onPastWheel, capture);
      historyElement.addEventListener('touchstart', onPastTouchStart, capture);
      historyElement.addEventListener('touchmove', onPastTouchMove, capture);
      historyElement.addEventListener('touchend', onPastTouchEnd, capture);

      const observer = new ResizeObserver(() => {
        fit.fit();
        past?.fit.fit();
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'resize', ...size() }));
        }
      });
      observer.observe(element);

      cleanup = () => {
        observer.disconnect();
        element.removeEventListener('wheel', onLiveWheel, capture);
        element.removeEventListener('touchstart', onLiveTouchStart, capture);
        element.removeEventListener('touchmove', onLiveTouchMove, capture);
        element.removeEventListener('touchend', onLiveTouchEnd, capture);
        historyElement.removeEventListener('wheel', onPastWheel, capture);
        historyElement.removeEventListener(
          'touchstart',
          onPastTouchStart,
          capture,
        );
        historyElement.removeEventListener(
          'touchmove',
          onPastTouchMove,
          capture,
        );
        historyElement.removeEventListener('touchend', onPastTouchEnd, capture);
        backToLive.current = () => {};
        clearTimeout(waiting);
        past?.term.dispose();
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
        // Nothing goes to the PTY while the history is open (#522).
        term.onData((data) => {
          if (socket?.readyState !== WebSocket.OPEN) return;
          if (controller.state !== 'live') return;
          for (const bytes of inputFrames(data)) socket.send(bytes);
        });
        term.onBinary((data) => {
          if (socket?.readyState !== WebSocket.OPEN) return;
          if (controller.state !== 'live') return;
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
          } else if (value.type === 'history') {
            const lines = controller.received(value);
            if (lines) showPast(lines);
          } else if (value.type === 'error') {
            outcome = {
              phase: 'refused',
              message: describeRefusal(value.code, value.heldBy, value.message),
            };
          } else {
            const reason: TerminalCloseReason = value.reason;
            outcome = { phase: 'ended', message: CLOSE_REASON_LABEL[reason] };
          }
        };
        ws.onclose = (event) => {
          if (stale()) return;
          // An answer can no longer arrive; a shown history stays readable.
          if (controller.state === 'loading') closePast();
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
      setHistory('live');
    };
  }, [projectId, kind, slot, runId, sessionId, cardId, mode]);

  return (
    <div className="relative h-full min-h-64 w-full">
      <div
        ref={host}
        role="application"
        aria-label={
          mode === 'write' ? 'Terminal, in control' : 'Terminal, read-only'
        }
        className="h-full w-full touch-none overflow-hidden rounded-control bg-ground p-2"
      />
      <div
        className={`absolute inset-0 flex flex-col rounded-control bg-ground ${
          history === 'shown' ? '' : 'invisible pointer-events-none'
        }`}
        aria-hidden={history !== 'shown'}
      >
        <div className="flex flex-wrap items-center gap-2 border-line border-b px-2 py-1.5">
          <Badge tone="warn" size="md" label="History" />
          <span className="text-ink-2 text-sm" role="status">
            {history === 'shown' ? 'Earlier output, not the live screen' : ''}
          </span>
          <Button
            variant="glass"
            size="sm"
            className="ml-auto"
            onClick={() => backToLive.current()}
          >
            Back to live
          </Button>
        </div>
        <div
          ref={historyHost}
          role="log"
          aria-label="Terminal history, read-only"
          className="min-h-0 flex-1 touch-none overflow-hidden p-2"
        />
      </div>
      {history === 'loading' ? (
        <div className="pointer-events-none absolute top-2 right-2">
          <Badge tone="neutral" size="md" label="Loading history…" />
        </div>
      ) : null}
    </div>
  );
}
