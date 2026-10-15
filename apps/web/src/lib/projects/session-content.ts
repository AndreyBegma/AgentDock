import { SESSION_CONTENT_RETENTION_DAYS } from '@agentdock/shared';
import { ApiError, describeError } from '../api';

const { min, max } = SESSION_CONTENT_RETENTION_DAYS;

/**
 * The retention days the field holds, or null when it is not a whole number in
 * range. The API validates too; this keeps a bad value from being sent.
 */
export const parseRetention = (text: string): number | null => {
  if (!/^\d+$/.test(text.trim())) return null;
  const days = Number(text);
  return days >= min && days <= max ? days : null;
};

/** The sentence under the field, or undefined when the value is fine. */
export const retentionError = (text: string): string | undefined =>
  parseRetention(text) === null
    ? `Enter a whole number of days from ${min} to ${max}.`
    : undefined;

/** The plain warning next to the toggle (ADR-0021, spec 201 "UI"). */
export const CONTENT_WARNING =
  'When this is on, the runner sends what a Claude Code session says and does: prompts, tool inputs and outputs, and responses. It removes secrets by pattern (tokens, private keys, .env values), and a pattern can miss one. What is sent is stored in the database until the retention below passes, and operators of this project can read it. Sessions turned off here send metadata only.';

export function describeSessionContentError(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return 'Only administrators can change or purge session content.';
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'This project no longer exists, or you are not a member of it.';
  }
  return describeError(error);
}
