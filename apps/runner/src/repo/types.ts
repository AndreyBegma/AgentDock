import type { WatchedProject } from '@nautelle/shared/protocol';
import type { Exec } from '../detect/exec';
import type { PolicyConfig } from '../policy/schema';

/** What `repo.search` and `repo.read` read with (#622). */
export interface RepoDeps {
  exec: Exec;
  watchedProjects: () => readonly WatchedProject[];
  /** The runner-local policy as it is now (ADR-0047). */
  policy: () => PolicyConfig;
}
