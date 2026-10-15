import { z } from 'zod';

/**
 * The JSON Claude Code writes to a hook's stdin, as documented at
 * https://code.claude.com/docs/en/hooks (read 2026-10-14). Loose: Claude
 * Code adds fields release by release, and only the ones named here are read.
 */
const common = {
  session_id: z.string().min(1).max(200),
  cwd: z.string().min(1),
  permission_mode: z.string().optional(),
  hook_event_name: z.string().optional(),
};

export const sessionStartInputSchema = z.looseObject({
  ...common,
  source: z.string().optional(),
  model: z.unknown().optional(),
});

export const userPromptSubmitInputSchema = z.looseObject({
  ...common,
  prompt: z.string().default(''),
});

export const toolInputSchema = z.looseObject({
  ...common,
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  duration_ms: z.number().optional(),
});

export const postToolUseInputSchema = toolInputSchema.extend({
  tool_response: z.unknown().optional(),
});

export const postToolUseFailureInputSchema = toolInputSchema.extend({
  error: z.unknown().optional(),
});

export const permissionRequestInputSchema = toolInputSchema;

export const notificationInputSchema = z.looseObject({
  ...common,
  notification_type: z.string().optional(),
});

export const stopInputSchema = z.looseObject({
  ...common,
  last_assistant_message: z.string().optional(),
});

export const sessionEndInputSchema = z.looseObject({
  ...common,
  reason: z.string().optional(),
});

/** Every input has these; enough to know the session. */
export const commonInputSchema = z.looseObject(common);
export type CommonInput = z.infer<typeof commonInputSchema>;
