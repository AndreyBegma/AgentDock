import { HANDOFF_NOTE_TEMPLATE } from '@nautelle/shared';

/** A valid note (#449 D5) with `goal`, and `next` under "## Next". */
export const validNote = (goal = 'Ship the login page.', next = ''): string =>
  HANDOFF_NOTE_TEMPLATE.replace('## Goal\n', `## Goal\n${goal}\n`).replace(
    '## Next\n',
    next ? `## Next\n${next}\n` : '## Next\n',
  );

/** One assistant line of a Claude Code transcript. */
export const assistantLine = (options: {
  at: string;
  id: string;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  tools?: string[];
  text?: string;
  sidechain?: boolean;
}): string =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: options.sidechain ?? false,
    timestamp: options.at,
    message: {
      id: options.id,
      role: 'assistant',
      content: [
        ...(options.text ? [{ type: 'text', text: options.text }] : []),
        ...(options.tools ?? []).map((name, i) => ({
          type: 'tool_use',
          id: `t${i}`,
          name,
          input: {},
        })),
      ],
      usage: {
        input_tokens: options.input ?? 0,
        cache_read_input_tokens: options.cacheRead ?? 0,
        cache_creation_input_tokens: options.cacheWrite ?? 0,
        cache_creation: {
          ephemeral_5m_input_tokens:
            (options.cacheWrite ?? 0) - (options.cacheWrite1h ?? 0),
          ephemeral_1h_input_tokens: options.cacheWrite1h ?? 0,
        },
      },
    },
  });

/** One user prompt line of a Claude Code transcript. */
export const userLine = (at: string, text: string): string =>
  JSON.stringify({
    type: 'user',
    timestamp: at,
    message: { role: 'user', content: text },
  });
