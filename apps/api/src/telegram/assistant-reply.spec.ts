import {
  ASSISTANT_REPLIES,
  assistantReplyParts,
  capReachedText,
  inlineMarkdownV2,
  turnErrorText,
} from './assistant-reply';
import { TELEGRAM_TEXT_MAX } from './markdown-v2';

/** Every MarkdownV2 reserved character, unescaped, outside code and links. */
const UNESCAPED = /(?<!\\)[_*[\]()~`>#+\-=|{}.!]/;

describe('assistant replies in Telegram (#620)', () => {
  describe('inlineMarkdownV2', () => {
    it('escapes every reserved character of plain text', () => {
      const text = 'a_b*c[d]e(f)g~h`i>j#k+l-m=n|o{p}q.r!s\\t';
      expect(inlineMarkdownV2(text)).toBe(
        'a\\_b\\*c\\[d\\]e\\(f\\)g\\~h\\`i\\>j\\#k\\+l\\-m\\=n\\|o\\{p\\}q\\.r\\!s\\\\t',
      );
    });

    it('keeps bold, italic, strikethrough and inline code, escaped inside', () => {
      expect(inlineMarkdownV2('**C-12 (bug)** is _done._')).toBe(
        '*C\\-12 \\(bug\\)* is _done\\._',
      );
      expect(inlineMarkdownV2('run `bun run db:migrate` now.')).toBe(
        'run `bun run db:migrate` now\\.',
      );
      expect(inlineMarkdownV2('a `x\\`y` b')).toBe('a `x\\\\`y\\` b');
      expect(inlineMarkdownV2('~~old~~ *new*')).toBe('~old~ _new_');
    });

    it('keeps an http(s) link and escapes its label and url', () => {
      expect(
        inlineMarkdownV2('See [PR #5 (draft)](https://x.dev/pr/5?a=b_c) now'),
      ).toBe('See [PR \\#5 \\(draft\\)](https://x.dev/pr/5?a=b_c) now');
      expect(inlineMarkdownV2('[evil](javascript:alert(1))')).toBe(
        '\\[evil\\]\\(javascript:alert\\(1\\)\\)',
      );
    });

    it('leaves stray marks escaped: snake_case, 2 * 3, a lone star', () => {
      expect(inlineMarkdownV2('snake_case_name and 2 * 3 * 4')).toBe(
        'snake\\_case\\_name and 2 \\* 3 \\* 4',
      );
    });
  });

  describe('assistantReplyParts', () => {
    it('turns headings, lists, quotes and code blocks into MarkdownV2', () => {
      const [part] = assistantReplyParts(
        [
          '## Queue (2)',
          '- slot-1 waits',
          '1. Fix it.',
          '> quoted!',
          '```ts',
          'const a = `x`; // 1.0',
          '```',
        ].join('\n'),
      );
      expect(part.text).toBe(
        [
          '*Queue \\(2\\)*',
          '• slot\\-1 waits',
          '1\\. Fix it\\.',
          '>quoted\\!',
          '```ts',
          'const a = \\`x\\`; // 1.0',
          '```',
        ].join('\n'),
      );
    });

    it('closes an unclosed code block at the end', () => {
      const [part] = assistantReplyParts('Look:\n```\nline 1');
      expect(part.text).toBe('Look:\n```\nline 1\n```');
    });

    it('is one message when it fits, none when blank', () => {
      expect(assistantReplyParts('Две вещи.')).toEqual([
        { text: 'Две вещи\\.', plain: 'Две вещи.' },
      ]);
      expect(assistantReplyParts('  \n ')).toEqual([]);
    });

    it('splits a long reply between lines, each part within the limit', () => {
      const line = 'Card C-1 (bug) is done. '.repeat(10).trim();
      const reply = Array.from({ length: 60 }, () => line).join('\n');
      const parts = assistantReplyParts(reply);
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(part.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
        expect(part.text.replace(/\\./g, '')).not.toMatch(UNESCAPED);
      }
      expect(parts.map((p) => p.plain).join('\n')).toBe(reply.trim());
    });

    it('splits a long code block into closed blocks', () => {
      const lines = Array.from({ length: 400 }, (_, i) => `line ${i} = "x";`);
      const parts = assistantReplyParts(`\`\`\`\n${lines.join('\n')}\n\`\`\``);
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(part.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
        expect(part.text.startsWith('```\n')).toBe(true);
        expect(part.text.endsWith('\n```')).toBe(true);
      }
    });

    it('chops one line longer than a message into escaped pieces', () => {
      const parts = assistantReplyParts('.'.repeat(5_000), 1_000);
      expect(parts.length).toBe(10);
      for (const part of parts) {
        expect(part.text.length).toBeLessThanOrEqual(1_000);
        expect(part.text).toMatch(/^(\\\.)+$/);
      }
    });
  });

  describe('fixed texts', () => {
    it('names the provider and the reset day when the cap is reached', () => {
      expect(capReachedText('anthropic', '2026-11-01T00:00:00.000Z')).toBe(
        'Anthropic reached its monthly AI spending cap. The assistant answers again on 1 November 2026 (UTC).',
      );
      expect(
        turnErrorText({
          code: 'llm_cap_reached',
          provider: 'openai',
          resetsAt: '2026-12-01T00:00:00.000Z',
        }),
      ).toContain('answers again on 1 December 2026');
    });

    it('tells setup problems from failures, never quoting the error', () => {
      expect(turnErrorText({ code: 'llm_key_missing' })).toBe(
        ASSISTANT_REPLIES.notSetUp,
      );
      expect(turnErrorText({ code: 'assistant_failed' })).toBe(
        ASSISTANT_REPLIES.failed,
      );
    });
  });
});
