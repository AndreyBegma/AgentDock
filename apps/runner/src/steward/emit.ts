import {
  STEWARD_ACTED_EVENT,
  STEWARD_OBSERVED_EVENT,
  STEWARD_REASON_MAX,
  type StewardActableSubject,
  type StewardActedData,
  type StewardObservedData,
  stewardActedDataSchema,
  stewardObservedDataSchema,
} from '@nautelle/shared';
import type { UnsequencedEvent } from '@nautelle/shared/protocol';
import { type Clock, isoNow } from '../clock';

/** The envelope's `project`: what every runner event of a project carries. */
export interface StewardEnvelope {
  repo: string;
  root: string;
}

export type StewardEmit = (event: UnsequencedEvent) => void;

/** One line of at most `STEWARD_REASON_MAX` characters, never empty. */
export const oneLine = (text: string, fallback: string): string => {
  const line = text.replace(/\s+/g, ' ').replaceAll('\u0000', '').trim();
  const cut =
    line.length > STEWARD_REASON_MAX
      ? `${line.slice(0, STEWARD_REASON_MAX - 1)}…`
      : line;
  return cut.length > 0 ? cut : fallback;
};

/**
 * #447 D2: `steward.observed`, validated by the shared schema before the
 * spool — a payload the API would refuse is never queued.
 */
export const emitObserved = (
  emit: StewardEmit,
  clock: Clock,
  project: StewardEnvelope,
  data: Omit<StewardObservedData, 'at'>,
): void => {
  const at = isoNow(clock);
  emit({
    v: 1,
    ts: at,
    type: STEWARD_OBSERVED_EVENT,
    source: 'runner',
    project,
    data: stewardObservedDataSchema.parse({ ...data, at }),
  });
};

/** #447 D2: `steward.acted` — every action, the record of it (not the result). */
export const emitActed = (
  emit: StewardEmit,
  clock: Clock,
  project: StewardEnvelope,
  data: Omit<StewardActedData, 'at' | 'subject'> & {
    subject: StewardActableSubject;
  },
): void => {
  const at = isoNow(clock);
  emit({
    v: 1,
    ts: at,
    type: STEWARD_ACTED_EVENT,
    source: 'runner',
    project,
    data: stewardActedDataSchema.parse({ ...data, at }),
  });
};
