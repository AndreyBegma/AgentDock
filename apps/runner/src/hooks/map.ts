import {
  HOOK_BACKGROUND_TASKS_MAX,
  HOOK_CLI_EVENT,
  type HookCliName,
  hookEndReasonSchema,
  hookStartSourceSchema,
  manualTmuxSessionSchema,
} from '@agentdock/shared/protocol';
import type { z } from 'zod';
import type {
  Ancestor,
  ContentField,
  LocalEventArgs,
  RawContent,
} from '../local/types';
import {
  notificationInputSchema,
  permissionRequestInputSchema,
  postToolUseFailureInputSchema,
  postToolUseInputSchema,
  sessionEndInputSchema,
  sessionStartInputSchema,
  stopInputSchema,
  userPromptSubmitInputSchema,
} from './input';

/** What the hook process adds beside its stdin (D10, D11, D23). */
export interface HookExtras {
  gitBranch?: string;
  /** `AGENTDOCK_TMUX_SESSION`, set by `agentdock-runner claude`. */
  tmuxSession?: string;
  ancestors?: Ancestor[];
  /** `stop` (#390): what still runs in the background, from the transcript. */
  background?: { tasks: number; command: string | null };
}

/**
 * Raw content is cut to this many characters before it goes on the socket;
 * the daemon caps it to `HOOK_CONTENT_MAX_CHARS` after redaction (D13), so
 * this leaves it room to mask a secret that straddles the cap.
 */
export const HOOK_RAW_CONTENT_CHARS = 24 * 1024;

const raw = (text: string, cap: number): RawContent =>
  text.length > cap
    ? { text: text.slice(0, cap), truncated: true }
    : { text, truncated: false };

/** `tool_input` as JSON (D13); a string stays as it is. */
export const stringify = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

const notificationType = (value: string | undefined): string => {
  const normalized = (value ?? '')
    .toLowerCase()
    .replace(/[^a-z_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return normalized.length > 0 ? normalized : 'unknown';
};

const durationMs = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;

type Built = Omit<LocalEventArgs, 'type' | 'sessionId' | 'cwd'>;

const contentOf = (
  entries: [ContentField, string | undefined][],
  cap: number,
): Built['content'] => {
  const out: Partial<Record<ContentField, RawContent>> = {};
  for (const [field, text] of entries) {
    if (text !== undefined && text.length > 0) out[field] = raw(text, cap);
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const parse = <S extends z.ZodType>(
  schema: S,
  input: unknown,
): z.infer<S> | null => {
  const parsed = schema.safeParse(input);
  return parsed.success ? parsed.data : null;
};

/**
 * One hook's stdin → the `event` op for the daemon (D11), or null when the
 * input lacks what the event needs. The daemon owns the content gate: the
 * raw texts ride in `content` and become fields only for a project that
 * ships content.
 */
export const buildHookEvent = (
  name: HookCliName,
  input: unknown,
  extras: HookExtras = {},
  cap = HOOK_RAW_CONTENT_CHARS,
): LocalEventArgs | null => {
  const built = buildData(name, input, extras, cap);
  if (!built) return null;
  const { session_id, cwd } = built.input;
  if (!cwd.startsWith('/')) return null;
  return {
    type: HOOK_CLI_EVENT[name],
    sessionId: session_id,
    cwd,
    data: built.data,
    ...(built.content ? { content: built.content } : {}),
    ...(name === 'session-start' && extras.ancestors
      ? { ancestors: extras.ancestors.slice(0, 32) }
      : {}),
  };
};

interface BuiltData {
  input: { session_id: string; cwd: string };
  data: Record<string, unknown>;
  content?: Built['content'];
}

const buildData = (
  name: HookCliName,
  input: unknown,
  extras: HookExtras,
  cap: number,
): BuiltData | null => {
  switch (name) {
    case 'session-start': {
      const i = parse(sessionStartInputSchema, input);
      if (!i) return null;
      const source = hookStartSourceSchema.safeParse(i.source);
      const tmux = manualTmuxSessionSchema.safeParse(extras.tmuxSession);
      const model =
        typeof i.model === 'string' &&
        i.model.length > 0 &&
        i.model.length <= 200
          ? i.model
          : undefined;
      return {
        input: i,
        data: {
          source: source.success ? source.data : 'startup',
          cwd: i.cwd,
          ...(extras.gitBranch ? { gitBranch: extras.gitBranch } : {}),
          ...(model ? { model } : {}),
          permissionMode: (i.permission_mode || 'default').slice(0, 32),
          ...(tmux.success ? { tmuxSession: tmux.data } : {}),
        },
      };
    }
    case 'user-prompt-submit': {
      const i = parse(userPromptSubmitInputSchema, input);
      if (!i) return null;
      return {
        input: i,
        data: { chars: i.prompt.length },
        content: contentOf([['content', i.prompt]], cap),
      };
    }
    case 'post-tool-use':
    case 'post-tool-use-failure': {
      const failed = name === 'post-tool-use-failure';
      const i = failed
        ? parse(postToolUseFailureInputSchema, input)
        : parse(postToolUseInputSchema, input);
      if (!i?.tool_use_id) return null;
      const output = stringify(
        'error' in i
          ? i.error
          : 'tool_response' in i
            ? i.tool_response
            : undefined,
      );
      const duration = durationMs(i.duration_ms);
      return {
        input: i,
        data: {
          toolUseId: i.tool_use_id.slice(0, 200),
          toolName: i.tool_name.slice(0, 200),
          ok: !failed,
          ...(duration !== undefined ? { durationMs: duration } : {}),
        },
        content: contentOf(
          [
            ['input', stringify(i.tool_input)],
            ['output', output],
          ],
          cap,
        ),
      };
    }
    case 'permission-request': {
      const i = parse(permissionRequestInputSchema, input);
      if (!i) return null;
      return { input: i, data: { toolName: i.tool_name.slice(0, 200) } };
    }
    case 'notification': {
      const i = parse(notificationInputSchema, input);
      if (!i) return null;
      return {
        input: i,
        data: { notificationType: notificationType(i.notification_type) },
      };
    }
    case 'stop': {
      const i = parse(stopInputSchema, input);
      if (!i) return null;
      const background = extras.background;
      return {
        input: i,
        data: background
          ? {
              backgroundTasks: Math.min(
                background.tasks,
                HOOK_BACKGROUND_TASKS_MAX,
              ),
            }
          : {},
        content: contentOf(
          [
            ['response', i.last_assistant_message],
            ['background', background?.command ?? undefined],
          ],
          cap,
        ),
      };
    }
    case 'session-end': {
      const i = parse(sessionEndInputSchema, input);
      if (!i) return null;
      const reason = hookEndReasonSchema.safeParse(i.reason);
      return {
        input: i,
        data: { reason: reason.success ? reason.data : 'other' },
      };
    }
  }
};
