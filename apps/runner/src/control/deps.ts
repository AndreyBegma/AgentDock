import type { WatchedProject } from '@agentdock/shared/protocol';
import type { Clock } from '../clock';
import type { ConfigProfile } from '../config';
import type { Exec } from '../detect/exec';

/** What the control commands need from the runner (spec 17). */
export interface ControlDeps {
  exec: Exec;
  clock: Clock;
  /** The current watch list, as the server last sent it. */
  watchedProjects: () => readonly WatchedProject[];
  /** The runtime profiles of the runner config (ADR-0006). */
  profiles: () => readonly ConfigProfile[];
  /** The tmux server: empty for the user's own, `['-L', name]` in tests. */
  tmuxServer?: readonly string[];
}
