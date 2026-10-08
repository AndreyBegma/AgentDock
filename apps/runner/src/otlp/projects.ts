import type { WatchedProject } from '@agentdock/shared/protocol';
import type { Exec } from '../detect/exec';
import { resolveFleetProject } from '../fleet/project';
import type { EnvelopeProject } from './map';

/**
 * `agentdock.project` → the envelope `project` (D14). Only an id on the
 * runner's watch list resolves, the same trust rule as `session.observed`.
 * `repo` is resolved through git once per project, as the fleet collectors
 * do, so OTel events carry the project exactly as fleet events name it.
 */
export class ProjectDirectory {
  private readonly cache = new Map<string, Promise<EnvelopeProject>>();

  constructor(
    private readonly options: {
      projects: () => readonly WatchedProject[];
      exec: Exec;
    },
  ) {}

  /** Resolves the given ids; unknown ids are left out. */
  async resolve(ids: Iterable<string>): Promise<Map<string, EnvelopeProject>> {
    const watched = this.options.projects();
    const out = new Map<string, EnvelopeProject>();
    for (const id of new Set(ids)) {
      const project = watched.find((p) => p.id === id);
      if (!project) continue;
      const key = `${project.id}\0${project.root}`;
      let pending = this.cache.get(key);
      if (!pending) {
        pending = resolveFleetProject(this.options.exec, project).then(
          (fleet) => ({ repo: fleet.repo, root: fleet.root }),
        );
        // A failed resolution is retried on the next request.
        pending.catch(() => this.cache.delete(key));
        this.cache.set(key, pending);
      }
      try {
        out.set(id, await pending);
      } catch {
        // Without its repo the project is left off the envelope, not guessed.
      }
    }
    return out;
  }
}
