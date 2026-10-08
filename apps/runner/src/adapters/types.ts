import type {
  Runtime,
  SessionObservedData,
  UnsequencedEvent,
  WatchedProject,
} from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../config';

/** One transcript file of one runtime session (D2). */
export interface TranscriptSource {
  runtime: Runtime;
  /** The profile whose directory holds the file. */
  profileKey: string;
  /** Absolute path of the file. */
  path: string;
  /** The runtime's own id of the session the file holds. */
  sessionId: string;
  /** Set for a subagent transcript: its parent session and how it was spawned. */
  parent?: { sessionId: string; toolUseId?: string; agentName?: string };
  size: number;
  mtimeMs: number;
}

/**
 * What the runner remembers about one transcript between reads, persisted in
 * `offsets.json` (D5). `offset` is the byte after the last complete line read.
 * `observed` is the `session.observed` data as last sent, so a change of any
 * field — including the correlation — is sent again. `parser` is the
 * adapter's own state; an adapter that cannot read it starts it afresh.
 */
export interface FileState {
  offset: number;
  observed: SessionObservedData | null;
  parser: unknown;
}

export const freshState = (): FileState => ({
  offset: 0,
  observed: null,
  parser: null,
});

/** The project and slot a session belongs to (D6); both absent when none. */
export interface Correlation {
  projectId?: string;
  slot?: string;
}

/** A batch of events read from a transcript, and the state after them. */
export interface TailChunk {
  events: UnsequencedEvent[];
  state: FileState;
}

export interface TailOptions {
  /** The watch list, for the correlation of `session.observed`. */
  projects: readonly WatchedProject[];
}

/**
 * Reads one runtime's transcripts (D1, ADR-0006). One adapter per runtime,
 * registered by `runtime` in `adapters/index.ts`.
 */
export interface RuntimeAdapter {
  readonly runtime: Runtime;
  /** Bumped when the parser's reading of the format changes. */
  readonly version: string;
  /** Directories to watch for this profile; missing ones are skipped. */
  roots(profile: ConfigProfile, home: string): string[];
  /** Every transcript of the profile, as it is on disk now. */
  discover(profile: ConfigProfile, home: string): TranscriptSource[];
  /**
   * Reads complete lines from `state.offset` to the end of the file, in
   * chunks. Each chunk's state is safe to persist once its events are sent.
   */
  tail(
    source: TranscriptSource,
    state: FileState,
    options: TailOptions,
  ): AsyncIterable<TailChunk>;
  correlate(
    meta: { cwd: string },
    projects: readonly WatchedProject[],
  ): Correlation;
}
