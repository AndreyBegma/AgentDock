import type { SessionContentKind } from '@agentdock/shared';
import {
  HOOK_PROMPT_SUBMITTED_EVENT,
  HOOK_STOPPED_EVENT,
  HOOK_TOOL_FINISHED_EVENT,
  type HookEvent,
  isHookEventType,
  type RunnerEvent,
} from '@agentdock/shared/protocol';

/** The `data` keys of a hook event that carry content (ADR-0021). */
const CONTENT_KEYS = [
  'content',
  'input',
  'output',
  'response',
  'background',
] as const;

/** One `session_contents` row, before it has a session and a time. */
export interface ContentDraft {
  kind: SessionContentKind;
  toolUseId: string | null;
  toolName: string | null;
  text: string;
  truncated: boolean;
}

/** The content rows a hook event carries (D13): prompt, tool input/output, response. */
export const contentDraftsOf = (event: HookEvent): ContentDraft[] => {
  switch (event.type) {
    case HOOK_PROMPT_SUBMITTED_EVENT:
      return event.data.content
        ? [
            {
              kind: 'prompt',
              toolUseId: null,
              toolName: null,
              ...event.data.content,
            },
          ]
        : [];
    case HOOK_TOOL_FINISHED_EVENT: {
      const { toolUseId, toolName, input, output } = event.data;
      const drafts: ContentDraft[] = [];
      if (input) {
        drafts.push({ kind: 'tool_input', toolUseId, toolName, ...input });
      }
      if (output) {
        drafts.push({ kind: 'tool_output', toolUseId, toolName, ...output });
      }
      return drafts;
    }
    case HOOK_STOPPED_EVENT:
      return event.data.response
        ? [
            {
              kind: 'response',
              toolUseId: null,
              toolName: null,
              ...event.data.response,
            },
          ]
        : [];
    default:
      return [];
  }
};

/**
 * ADR-0021: content never reaches `events.data`. The runner events service
 * removes the content keys from the batch's event objects in place after
 * every sink ran — the sessions sink stores the content, the board sink the
 * running background command (#390) — and before it stores them. Done for
 * every hook-typed event, valid or not, so a malformed one cannot carry
 * content into the table either.
 */
export const stripHookContent = (event: RunnerEvent): void => {
  if (!isHookEventType(event.type)) return;
  const data = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
  const kept: Record<string, unknown> = { ...data };
  for (const key of CONTENT_KEYS) delete kept[key];
  event.data = kept;
};
