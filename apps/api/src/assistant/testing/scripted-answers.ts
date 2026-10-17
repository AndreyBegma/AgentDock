import { sseResponse } from '../../llm/providers/testing';
import { ENGLISH_MARKER } from '../bilingual';

/** The chat model of the assistant e2e tests. */
export const OPUS = 'claude-opus-5-5';

export type Block =
  | { text: string[] }
  | { tool: { id: string; name: string; input: object } };

/** One Anthropic answer: text blocks streamed piece by piece, tool calls whole. */
export const answer = (
  blocks: Block[],
  usage = { input: 1_000, output: 200 },
) => {
  const frames: { event: string; data: unknown }[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: OPUS,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: usage.input, output_tokens: 1 },
        },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if ('text' in block) {
      frames.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        },
      });
      for (const text of block.text) {
        frames.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text },
          },
        });
      }
    } else {
      frames.push(
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: block.tool.id,
              name: block.tool.name,
              input: {},
            },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify(block.tool.input),
            },
          },
        },
      );
    }
    frames.push({
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index },
    });
  });
  const tools = blocks.some((b) => 'tool' in b);
  frames.push(
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: tools ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: { output_tokens: usage.output },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  );
  return sseResponse(frames);
};

export const trailer = (language: string, reply: string, message: string) =>
  `\n${ENGLISH_MARKER}\n${JSON.stringify({ language, reply, message })}`;

/** A reply in English, in three streamed pieces. */
export const english = (reply: string, message: string) => [
  reply.slice(0, 5),
  reply.slice(5),
  trailer('en', reply, message),
];
