import {
  COMMAND_RESULT_EVENT,
  type CommandResultMessage,
  commandResultMessageSchema,
  type RunnerEvent,
} from '@nautelle/shared/protocol';

/**
 * The `command.result` a `runner.command_result` event carries (#740 D1);
 * null for any other event, or one whose data does not parse.
 */
export const commandResultOf = (
  event: RunnerEvent,
): CommandResultMessage | null => {
  if (event.type !== COMMAND_RESULT_EVENT || event.source !== 'runner') {
    return null;
  }
  const parsed = commandResultMessageSchema.safeParse(event.data);
  return parsed.success ? parsed.data : null;
};

/**
 * Cuts a `runner.command_result` event's data to `{ id, ok }` before it is
 * stored (#740 D1): the row fills its seq, so the ack advances; the output
 * already went to the waiter and is never kept.
 */
export const stripCommandResult = (event: RunnerEvent): void => {
  if (event.type !== COMMAND_RESULT_EVENT) return;
  const data = event.data;
  const { id, ok } =
    typeof data === 'object' && data !== null
      ? (data as { id?: unknown; ok?: unknown })
      : {};
  event.data = {
    id: typeof id === 'string' ? id : null,
    ok: typeof ok === 'boolean' ? ok : null,
  };
};
