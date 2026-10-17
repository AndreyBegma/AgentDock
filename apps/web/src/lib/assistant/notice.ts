import type { AssistantStreamEvent } from '@agentdock/shared';
import { LLM_PROVIDER_INFO } from '@agentdock/shared';

type StreamError = Extract<AssistantStreamEvent, { type: 'error' }>;

export interface TurnNotice {
  /** A cap is a state of the provider, not a fault: it gets its own look. */
  tone: 'cap' | 'error';
  title: string;
  text: string;
}

/** `Nov 1` in the person's timezone; the cap resets at 00:00 UTC on the 1st. */
export const resetDate = (resetsAt: string, timeZone?: string): string =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(resetsAt));

/**
 * What the thread says when a turn fails. A reached cap names the provider and
 * the date it resets; anything else is the server's own sentence.
 */
export function noticeFor(error: StreamError, timeZone?: string): TurnNotice {
  if (error.code === 'llm_cap_reached') {
    const provider = error.provider
      ? LLM_PROVIDER_INFO[error.provider].label
      : 'The provider';
    const when = error.resetsAt
      ? ` It resets on ${resetDate(error.resetsAt, timeZone)}.`
      : '';
    return {
      tone: 'cap',
      title: `${provider} has reached its monthly cap`,
      text: `The assistant cannot answer with ${provider} until then.${when} Pick another model to continue.`,
    };
  }
  return {
    tone: 'error',
    title: 'The assistant could not answer',
    text: error.message,
  };
}
