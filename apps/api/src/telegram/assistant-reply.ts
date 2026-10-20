import { LLM_PROVIDER_INFO, type LlmProviderId } from '@agentdock/shared';
import {
  escapeLinkUrl,
  escapeMarkdownV2,
  TELEGRAM_TEXT_MAX,
} from './markdown-v2';

/**
 * #620: an assistant reply as Telegram messages. The model writes Markdown;
 * the chat gets MarkdownV2 with the few marks both share — bold, italic,
 * strikethrough, inline code, code blocks, http(s) links, quotes — and every
 * other character escaped, so nothing in the reply can become markup it did
 * not mean. A reply past Telegram's limit is split between lines, never
 * inside a mark; each part keeps its plain text, sent as is if Telegram
 * still refuses the markup.
 */

export interface ReplyPart {
  /** MarkdownV2. */
  text: string;
  /** The same part as the model wrote it, for a plain-text retry. */
  plain: string;
}

/** Inside `` `code` `` and ```` ``` ```` blocks only `` ` `` and `\` are escaped. */
const escapeCode = (text: string): string =>
  text.replace(/[`\\]/g, (c) => `\\${c}`);

/** One inline mark, by the group that matched. */
const INLINE = new RegExp(
  [
    /`([^`\n]+)`/.source,
    /\*\*(?=\S)([^*\n]*?\S)\*\*/.source,
    /__(?=\S)([^_\n]*?\S)__/.source,
    /(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/.source,
    /(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/.source,
    /~~(?=\S)([^~\n]*?\S)~~/.source,
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.source,
  ].join('|'),
  'g',
);

/** A line's inline marks as MarkdownV2; the rest escaped. */
export const inlineMarkdownV2 = (line: string): string => {
  let out = '';
  let last = 0;
  for (const match of line.matchAll(INLINE)) {
    const index = match.index ?? 0;
    out += escapeMarkdownV2(line.slice(last, index));
    const [, code, bold, bold2, italic, italic2, strike, label, url] = match;
    if (code !== undefined) out += `\`${escapeCode(code)}\``;
    else if (bold !== undefined || bold2 !== undefined) {
      out += `*${escapeMarkdownV2(bold ?? bold2)}*`;
    } else if (italic !== undefined || italic2 !== undefined) {
      out += `_${escapeMarkdownV2(italic ?? italic2)}_`;
    } else if (strike !== undefined) out += `~${escapeMarkdownV2(strike)}~`;
    else out += `[${escapeMarkdownV2(label)}](${escapeLinkUrl(url)})`;
    last = index + match[0].length;
  }
  return out + escapeMarkdownV2(line.slice(last));
};

/** One line outside a code block. */
const lineMarkdownV2 = (line: string): string => {
  const heading = /^#{1,6}\s+(.*)$/.exec(line);
  if (heading) return heading[1] ? `*${escapeMarkdownV2(heading[1])}*` : '';
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}• ${inlineMarkdownV2(bullet[2])}`;
  const numbered = /^(\s*)(\d{1,9})\.\s+(.*)$/.exec(line);
  if (numbered) {
    return `${numbered[1]}${numbered[2]}\\. ${inlineMarkdownV2(numbered[3])}`;
  }
  const quote = /^>\s?(.*)$/.exec(line);
  if (quote) return `>${inlineMarkdownV2(quote[1])}`;
  return inlineMarkdownV2(line);
};

type Block =
  | { kind: 'line'; text: string }
  | { kind: 'code'; lang: string; lines: string[] };

/** The reply's lines, with each fenced code block as one block. */
const blocksOf = (markdown: string): Block[] => {
  const blocks: Block[] = [];
  let code: Extract<Block, { kind: 'code' }> | null = null;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (code) {
      if (fence && !fence[1]) {
        blocks.push(code);
        code = null;
      } else code.lines.push(line);
    } else if (fence) code = { kind: 'code', lang: fence[1], lines: [] };
    else blocks.push({ kind: 'line', text: line });
  }
  // An unclosed fence closes at the end of the reply.
  if (code) blocks.push(code);
  return blocks;
};

const codeText = (lang: string, lines: string[]): string =>
  `\`\`\`${lang}\n${escapeCode(lines.join('\n'))}\n\`\`\``;

const codePlain = (lang: string, lines: string[]): string =>
  `\`\`\`${lang}\n${lines.join('\n')}\n\`\`\``;

/** Plain text in pieces whose escaped form fits `max` (escaping at most doubles it). */
const chop = (text: string, max: number): ReplyPart[] => {
  const size = Math.floor(max / 2);
  const parts: ReplyPart[] = [];
  for (let i = 0; i < text.length; i += size) {
    const plain = text.slice(i, i + size);
    parts.push({ text: escapeMarkdownV2(plain), plain });
  }
  return parts;
};

/** A block as parts that each fit `max`; one part unless it is too long. */
const partsOf = (block: Block, max: number): ReplyPart[] => {
  if (block.kind === 'line') {
    const text = lineMarkdownV2(block.text);
    return text.length <= max
      ? [{ text, plain: block.text }]
      : chop(block.text, max);
  }
  const whole = codeText(block.lang, block.lines);
  if (whole.length <= max) {
    return [{ text: whole, plain: codePlain(block.lang, block.lines) }];
  }
  // A long block goes out as several blocks, a run of whole lines each.
  const parts: ReplyPart[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length === 0) return;
    parts.push({
      text: codeText(block.lang, lines),
      plain: codePlain(block.lang, lines),
    });
    lines = [];
  };
  for (const line of block.lines) {
    if (codeText(block.lang, [...lines, line]).length <= max) {
      lines.push(line);
      continue;
    }
    flush();
    if (codeText(block.lang, [line]).length <= max) lines.push(line);
    else parts.push(...chop(line, max));
  }
  flush();
  return parts;
};

/**
 * The reply as MarkdownV2 messages of at most `max` characters, whole lines
 * packed into each; a blank reply is no message.
 */
export const assistantReplyParts = (
  markdown: string,
  max = TELEGRAM_TEXT_MAX,
): ReplyPart[] => {
  const messages: ReplyPart[] = [];
  let current: ReplyPart | null = null;
  for (const block of blocksOf(markdown.trim())) {
    for (const part of partsOf(block, max)) {
      if (current && current.text.length + 1 + part.text.length <= max) {
        current = {
          text: `${current.text}\n${part.text}`,
          plain: `${current.plain}\n${part.plain}`,
        };
      } else {
        if (current) messages.push(current);
        current = part;
      }
    }
  }
  if (current) messages.push(current);
  return messages
    .map((m) => ({ text: m.text.trim(), plain: m.plain.trim() }))
    .filter((m) => m.text.length > 0);
};

export const ASSISTANT_REPLIES = {
  newChat:
    'Started a new conversation. Your next message begins it; the earlier one stays in Nautelle.',
  busy: 'The assistant is still answering your previous message. Send this one again once the reply arrives.',
  tooLong: 'That message is too long for the assistant. Send a shorter one.',
  empty: 'The assistant gave no answer. Try again.',
  failed: 'The assistant could not answer. Try again in a moment.',
  notSetUp:
    'The assistant is not set up: an admin enables an AI provider in Nautelle → Admin → AI providers.',
  photoNeedsProject:
    'A photo is stored on a project. Pick this chat’s project with /project, then send the photo again.',
  photoNeedsCaption: 'Add a caption to the photo to send it to the assistant.',
} as const;

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Fixed text: the provider at its cap and the day calls resume. */
export const capReachedText = (
  provider: LlmProviderId | undefined,
  resetsAt: string | undefined,
): string => {
  const label = provider
    ? LLM_PROVIDER_INFO[provider].label
    : 'The AI provider';
  const when = resetsAt ? new Date(resetsAt) : null;
  return when && !Number.isNaN(when.getTime())
    ? `${label} reached its monthly AI spending cap. The assistant answers again on ${DAY.format(when)} (UTC).`
    : `${label} reached its monthly AI spending cap. The assistant answers again next month.`;
};

/** Gateway codes that mean the assistant is not configured, not that it failed. */
const NOT_SET_UP = new Set([
  'llm_provider_disabled',
  'llm_key_missing',
  'llm_key_rejected',
  'llm_model_not_enabled',
  'llm_model_unpriced',
  'llm_gateway_unavailable',
  'assistant_no_model',
  'assistant_model_not_enabled',
]);

/** A failed turn in the chat's words; never the error's own text. */
export const turnErrorText = (error: {
  code: string;
  provider?: LlmProviderId;
  resetsAt?: string;
}): string => {
  if (error.code === 'llm_cap_reached') {
    return capReachedText(error.provider, error.resetsAt);
  }
  return NOT_SET_UP.has(error.code)
    ? ASSISTANT_REPLIES.notSetUp
    : ASSISTANT_REPLIES.failed;
};
