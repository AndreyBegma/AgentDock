import type { ControlCommandName } from '@agentdock/shared/protocol';

/** Overrides of the D11 timeouts; e2e tests shorten them. */
export interface ControlOptions {
  timeoutsMs: Partial<Record<ControlCommandName, number>>;
}

export const CONTROL_OPTIONS = Symbol('CONTROL_OPTIONS');

/** No override: each command's own timeout from the protocol (D11). */
export const defaultControlOptions: ControlOptions = { timeoutsMs: {} };
