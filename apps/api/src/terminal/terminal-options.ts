import {
  TERMINAL_IDLE_TIMEOUT_SEC_DEFAULT,
  TERMINAL_MAX_DURATION_SEC_DEFAULT,
  TERMINAL_TICKET_TTL_MS,
} from '@agentdock/shared/protocol';
import type { ConfigService } from '@nestjs/config';

/** Limits of the terminal attach (spec 29 D5, D7); tests override the provider to run fast. */
export interface TerminalOptions {
  /** A ticket is single use and valid this long (D5). */
  ticketTtlMs: number;
  /** No input bytes (write) or no traffic at all (read) for this long closes with `idle` (D7). */
  idleTimeoutMs: number;
  /** An attach older than this closes with `max_duration` (D7). */
  maxDurationMs: number;
  /** Every attach's session is re-resolved this often; a dead one ends the attach. */
  revalidateMs: number;
}

export const TERMINAL_OPTIONS = Symbol('TERMINAL_OPTIONS');

/** A positive integer from the env, else `fallback`. */
const positive = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

export const terminalOptions = (config: ConfigService): TerminalOptions => ({
  ticketTtlMs: TERMINAL_TICKET_TTL_MS,
  idleTimeoutMs:
    positive(
      config.get<string>('TERMINAL_IDLE_TIMEOUT_SEC'),
      TERMINAL_IDLE_TIMEOUT_SEC_DEFAULT,
    ) * 1000,
  maxDurationMs:
    positive(
      config.get<string>('TERMINAL_MAX_DURATION_SEC'),
      TERMINAL_MAX_DURATION_SEC_DEFAULT,
    ) * 1000,
  revalidateMs: 60_000,
});
