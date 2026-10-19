import { LLM_PROVIDER_INFO, type LlmProviderId } from '@agentdock/shared';
import { ApiError, describeError } from '../api';
import { resetDate } from '../assistant/notice';

/** What a Summarize button shows when it fails. */
export interface SummaryNotice {
  /** A cap is a state of the provider, not a fault: it gets its own look. */
  tone: 'cap' | 'error';
  text: string;
}

const isProvider = (value: unknown): value is LlmProviderId =>
  typeof value === 'string' && value in LLM_PROVIDER_INFO;

/**
 * #658: a reached cap names the provider and the day it resets; the other
 * refusals say what to do; anything else is the usual sentence.
 */
export function summaryNotice(
  error: unknown,
  timeZone?: string,
): SummaryNotice {
  if (error instanceof ApiError) {
    const body = error.body ?? {};
    const code = typeof body.error === 'string' ? body.error : undefined;
    if (code === 'llm_cap_reached') {
      const provider = isProvider(body.provider)
        ? LLM_PROVIDER_INFO[body.provider].label
        : 'The AI provider';
      const when =
        typeof body.resetsAt === 'string'
          ? ` Summaries resume on ${resetDate(body.resetsAt, timeZone)}.`
          : '';
      return {
        tone: 'cap',
        text: `${provider} has reached its monthly cap.${when}`,
      };
    }
    if (code === 'summary_no_model') {
      return {
        tone: 'error',
        text: 'No AI model is set. An administrator picks one on Admin › AI providers.',
      };
    }
    if (code === 'summary_no_session_content') {
      return {
        tone: 'error',
        text: 'This session has no stored content to summarize.',
      };
    }
    if (code === 'llm_provider_disabled' || code === 'llm_key_missing') {
      return { tone: 'error', text: error.message };
    }
  }
  return { tone: 'error', text: describeError(error) };
}

/** `Haiku 5.5 · $0.003` under a summary: the model and what the call cost. */
export const summaryMeta = (summary: {
  model: string;
  costUsd: string;
  cached: boolean;
}): string => {
  const cost = Number(summary.costUsd);
  const spent =
    cost > 0 ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : '$0';
  return [summary.model, spent, ...(summary.cached ? ['cached'] : [])].join(
    ' · ',
  );
};

/**
 * #658 (ADR-0021): whether a session shows Summarize — only when the project
 * ships session content and this session has some the reader may see. A
 * summary reads that content, so without it there is nothing to summarize.
 */
export const canSummarizeSession = (session: {
  /** The session has stored content the reader may read. */
  hasContent: boolean | undefined;
  /** The project's `shipSessionContent`; unknown while it loads. */
  shipSessionContent: boolean | undefined;
}): boolean =>
  session.hasContent === true && session.shipSessionContent === true;
