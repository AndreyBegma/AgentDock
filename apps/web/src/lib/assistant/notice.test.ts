import { describe, expect, test } from 'bun:test';
import { noticeFor } from './notice';

describe('noticeFor', () => {
  test('a cap names the provider and the reset date', () => {
    const notice = noticeFor(
      {
        type: 'error',
        code: 'llm_cap_reached',
        message: 'x',
        provider: 'anthropic',
        resetsAt: '2026-11-01T00:00:00.000Z',
      },
      'UTC',
    );
    expect(notice.tone).toBe('cap');
    expect(notice.title).toContain('Anthropic');
    expect(notice.text).toContain('November 1, 2026');
  });

  test('a cap without a date still names the provider', () => {
    const notice = noticeFor({
      type: 'error',
      code: 'llm_cap_reached',
      message: 'x',
      provider: 'openai',
    });
    expect(notice.title).toContain('OpenAI');
    expect(notice.text).not.toContain('resets on');
  });

  test('any other error carries the server sentence', () => {
    expect(
      noticeFor({ type: 'error', code: 'assistant_failed', message: 'Boom' }),
    ).toEqual({
      tone: 'error',
      title: 'The assistant could not answer',
      text: 'Boom',
    });
  });
});
