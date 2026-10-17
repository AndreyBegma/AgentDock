import type { AssistantStreamEvent } from '@agentdock/shared';

/**
 * Splits a growing text into the complete `data:` events it holds and the
 * unfinished tail. Events are separated by a blank line; a line that is not
 * valid JSON is skipped rather than ending the stream.
 */
export function parseSse(buffer: string): {
  events: AssistantStreamEvent[];
  rest: string;
} {
  const events: AssistantStreamEvent[] = [];
  const blocks = buffer.replaceAll('\r\n', '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      events.push(JSON.parse(data) as AssistantStreamEvent);
    } catch {
      // A malformed event is dropped; the next one is independent.
    }
  }
  return { events, rest };
}
