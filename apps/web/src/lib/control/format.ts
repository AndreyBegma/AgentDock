import {
  CONTROL_ERROR,
  type CommandRunLiveEvent,
  type CommandRunView,
  type ControlErrorCode,
} from '@agentdock/shared';
import type {
  OrchestratorMode,
  OrchestratorPermissionMode,
} from '@agentdock/shared/protocol';
import { ApiError, describeError } from '../api';

/** Spec 17 D7: the text of a message to a worker, counted in UTF-8 bytes. */
export const MESSAGE_MAX_BYTES = 16 * 1024;

const encoder = new TextEncoder();

export const utf8ByteLength = (text: string): number =>
  encoder.encode(text).length;

/** "1.2 KB of 16 KB" — what the textarea hint shows. */
export function describeMessageSize(text: string): string {
  const bytes = utf8ByteLength(text);
  const kb = (n: number) => `${Math.round((n / 1024) * 10) / 10} KB`;
  return `${kb(bytes)} of ${kb(MESSAGE_MAX_BYTES)}`;
}

export type MessageProblem = 'blank' | 'too_long';

/** Why a message cannot be sent, or null; mirrors the protocol's rule. */
export function messageProblem(text: string): MessageProblem | null {
  if (text.trim() === '') return 'blank';
  return utf8ByteLength(text) > MESSAGE_MAX_BYTES ? 'too_long' : null;
}

export const PERMISSION_MODES: readonly OrchestratorPermissionMode[] = [
  'auto',
  'acceptEdits',
  'manual',
  'bypassPermissions',
];

export const PERMISSION_MODE_LABEL: Record<OrchestratorPermissionMode, string> =
  {
    auto: 'auto',
    acceptEdits: 'accept edits',
    manual: 'manual (prompts)',
    bypassPermissions: 'bypass permissions (admin only)',
  };

/** D3: `bypassPermissions` is offered to admins only; the API enforces it anyway. */
export const permissionModesFor = (
  isAdmin: boolean,
): readonly OrchestratorPermissionMode[] =>
  PERMISSION_MODES.filter((mode) => isAdmin || mode !== 'bypassPermissions');

export const MODE_LABEL: Record<OrchestratorMode, string> = {
  start: 'start — begin a round',
  next: 'next — resume from the board',
};

/** One sentence per error code of the control routes (#59). */
export const CONTROL_ERROR_SENTENCE: Record<ControlErrorCode, string> = {
  [CONTROL_ERROR.notFound]:
    'This project no longer exists, or you are not a member of it.',
  [CONTROL_ERROR.forbidden]: 'Your role on this project does not allow that.',
  [CONTROL_ERROR.invalidArgs]:
    'The request was rejected as invalid; nothing was sent to the machine.',
  [CONTROL_ERROR.noProfile]:
    'No runtime profile is set. Pick one in the Orchestrator settings or set a default profile for the project.',
  [CONTROL_ERROR.unknownProfile]:
    'That runtime profile is not available on the project’s machine. Pick another one in the Orchestrator settings.',
  [CONTROL_ERROR.unsupportedRuntime]:
    'The orchestrator runs on Claude profiles only; a Codex profile cannot start it yet.',
  [CONTROL_ERROR.alreadyRunning]: 'The orchestrator is already running.',
  [CONTROL_ERROR.runnerOffline]:
    'The runner on the project’s machine is offline. Nothing was sent.',
  [CONTROL_ERROR.runnerTimeout]:
    'The runner did not answer in time. The outcome is unknown — refresh the status before trying again.',
  [CONTROL_ERROR.pathNotAllowed]:
    'That path or slot does not belong to this project.',
  [CONTROL_ERROR.runnerError]:
    'The runner failed to carry the command out. Check the runner’s log on its machine.',
};

const isControlErrorCode = (
  code: string | undefined,
): code is ControlErrorCode =>
  code !== undefined &&
  (Object.values(CONTROL_ERROR) as string[]).includes(code);

/** A sentence for a failed control request. */
export function describeControlError(error: unknown): string {
  if (!(error instanceof ApiError)) return describeError(error);
  const code = error.code as string | undefined;
  if (isControlErrorCode(code)) return CONTROL_ERROR_SENTENCE[code];
  if (error.status === 403) return CONTROL_ERROR_SENTENCE.forbidden;
  if (error.status === 404) return CONTROL_ERROR_SENTENCE.not_found;
  if (error.status === 504) return CONTROL_ERROR_SENTENCE.runner_timeout;
  if (error.status === 502) return CONTROL_ERROR_SENTENCE.runner_error;
  return describeError(error);
}

type Run = Pick<CommandRunLiveEvent, 'command' | 'slot' | 'status' | 'error'> &
  Partial<Pick<CommandRunView, 'result'>>;

const SUBJECT: Record<Run['command'], (slot: string | null) => string> = {
  'orchestrator.start': () => 'Orchestrator start',
  'orchestrator.stop': () => 'Orchestrator stop',
  'slot.stop': (slot) => `Stopping slot ${slot ?? ''}`.trim(),
  'slot.message': (slot) => `Message to ${slot ?? 'the worker'}`,
};

export const COMMAND_PENDING_LABEL: Record<Run['command'], string> = {
  'orchestrator.start': 'Starting the orchestrator…',
  'orchestrator.stop': 'Stopping the orchestrator…',
  'slot.stop': 'Stopping the slot…',
  'slot.message': 'Sending the message…',
};

export interface Outcome {
  tone: 'success' | 'error' | 'info';
  text: string;
}

/** The toast for a run that left `requested`; null while it is still pending. */
export function describeOutcome(run: Run): Outcome | null {
  const subject = SUBJECT[run.command](run.slot);
  switch (run.status) {
    case 'requested':
      return null;
    case 'unknown':
      return {
        tone: 'error',
        text: `${subject}: the runner never answered, so the outcome is unknown.`,
      };
    case 'error':
      return {
        tone: 'error',
        text: `${subject} failed. ${run.error ? CONTROL_ERROR_SENTENCE[run.error.code] : ''}`.trim(),
      };
    case 'ok':
      return okOutcome(run, subject);
  }
}

function okOutcome(run: Run, subject: string): Outcome {
  const result = run.result ?? {};
  switch (run.command) {
    case 'orchestrator.start': {
      const session = typeof result.session === 'string' ? result.session : '';
      return {
        tone: 'success',
        text: session
          ? `Orchestrator started in tmux session ${session}.`
          : 'Orchestrator started.',
      };
    }
    case 'orchestrator.stop':
      return result.stopped === false
        ? { tone: 'info', text: 'The orchestrator was not running.' }
        : {
            tone: 'success',
            text: 'Orchestrator stopped. Workers keep running.',
          };
    case 'slot.stop':
      return result.stopped === false
        ? { tone: 'info', text: `Slot ${run.slot} had no live session.` }
        : {
            tone: 'success',
            text: `Slot ${run.slot} stopped. Its worktree and branch are kept.`,
          };
    case 'slot.message':
      return result.delivered === false
        ? {
            tone: 'info',
            text: `${subject} saved, but the worker’s session is not live. It waits in the worktree until the worker is resumed.`,
          }
        : { tone: 'success', text: `${subject} delivered.` };
  }
}
