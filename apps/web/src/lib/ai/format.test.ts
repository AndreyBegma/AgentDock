import { describe, expect, test } from 'bun:test';
import { ApiError } from '../api';
import { canSummarizeSession, summaryMeta, summaryNotice } from './format';

const refusal = (status: number, body: Record<string, unknown>) =>
  new ApiError(status, undefined, String(body.message ?? ''), undefined, body);

describe('summaryNotice', () => {
  test('names the provider and the reset day when the cap is reached', () => {
    const notice = summaryNotice(
      refusal(429, {
        error: 'llm_cap_reached',
        message: 'Anthropic reached its $200.00 monthly cap',
        provider: 'anthropic',
        resetsAt: '2026-11-01T00:00:00.000Z',
      }),
      'UTC',
    );
    expect(notice).toEqual({
      tone: 'cap',
      text: 'Anthropic has reached its monthly cap. Summaries resume on November 1, 2026.',
    });
  });

  test('says what to do without a model or session content', () => {
    expect(
      summaryNotice(refusal(409, { error: 'summary_no_model', message: '' }))
        .text,
    ).toContain('Admin › AI providers');
    expect(
      summaryNotice(
        refusal(409, { error: 'summary_no_session_content', message: '' }),
      ).text,
    ).toContain('no stored content');
  });

  test('falls back to the usual sentence', () => {
    expect(summaryNotice(new Error('boom'))).toEqual({
      tone: 'error',
      text: 'Could not reach the server.',
    });
  });
});

describe('summaryMeta', () => {
  test('shows the model, the cost and whether it came from the cache', () => {
    expect(
      summaryMeta({
        model: 'claude-haiku-5-5',
        costUsd: '0.0031',
        cached: false,
      }),
    ).toBe('claude-haiku-5-5 · $0.0031');
    expect(
      summaryMeta({ model: 'claude-haiku-5-5', costUsd: '0.12', cached: true }),
    ).toBe('claude-haiku-5-5 · $0.12 · cached');
  });
});

describe('canSummarizeSession', () => {
  test('is hidden without session content', () => {
    expect(
      canSummarizeSession({ hasContent: false, shipSessionContent: true }),
    ).toBe(false);
    expect(
      canSummarizeSession({ hasContent: undefined, shipSessionContent: true }),
    ).toBe(false);
  });

  test('is hidden when the project does not ship content, or while it loads', () => {
    expect(
      canSummarizeSession({ hasContent: true, shipSessionContent: false }),
    ).toBe(false);
    expect(
      canSummarizeSession({ hasContent: true, shipSessionContent: undefined }),
    ).toBe(false);
  });

  test('shows with content of an opted-in project', () => {
    expect(
      canSummarizeSession({ hasContent: true, shipSessionContent: true }),
    ).toBe(true);
  });
});
