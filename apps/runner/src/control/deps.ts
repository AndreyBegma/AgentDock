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
  /** #445: the user's home, for the profile's MCP config; `os.homedir()` by default. */
  home?: string;
  /** #445: the argv that starts this runner; the daemon's own rule by default. */
  selfCommand?: readonly string[];
  /**
   * #445: where an orchestrator session's Token saver files go, one
   * directory per session; `<state>/agentdock/orchestrator` by default.
   */
  orchestratorDir?: string;
}
