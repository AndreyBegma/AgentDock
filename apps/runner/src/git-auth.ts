import type { GitGithubAuth } from '@agentdock/shared/protocol';
import type { Exec } from './detect/exec';

/**
 * #329 D1: what every `git` child gets while `gh` is authenticated for
 * github.com — SSH remotes are read as HTTPS, and HTTPS credentials come
 * from `gh`. The empty helper resets the helpers inherited for
 * `https://github.com` only; any other host keeps the machine's own setup.
 */
export const GITHUB_GIT_CONFIG: readonly (readonly [string, string])[] = [
  ['url.https://github.com/.insteadOf', 'git@github.com:'],
  ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
  ['credential.https://github.com.helper', ''],
  ['credential.https://github.com.helper', '!gh auth git-credential'],
];

/** `gh auth status` is local: it reads the stored token, nothing slower. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * #329 D1: how the runner's git reaches GitHub. The runner runs as a service
 * with no SSH agent, so when `gh` is logged in to github.com, git goes over
 * HTTPS with `gh`'s token; otherwise (`native`) nothing changes.
 *
 * The settings live here and in `wrap` only: call sites stay unchanged.
 */
export class GitAuth {
  private mode: GitGithubAuth = 'native';

  constructor(private readonly exec: Exec) {}

  /** The mode the last `probe` found; `native` before the first. */
  get github(): GitGithubAuth {
    return this.mode;
  }

  /** Re-checks `gh auth status --hostname github.com`; never throws. */
  async probe(): Promise<GitGithubAuth> {
    const status = await this.exec(
      'gh',
      ['auth', 'status', '--hostname', 'github.com'],
      { timeoutMs: PROBE_TIMEOUT_MS },
    ).catch(() => null);
    this.mode = status?.code === 0 ? 'gh' : 'native';
    return this.mode;
  }

  /**
   * `exec` with `GITHUB_GIT_CONFIG` added to every `git` call while the mode
   * is `gh`. Any other binary, and every call in `native`, is passed as is.
   */
  wrap(exec: Exec): Exec {
    return (binary, args, options) => {
      if (binary !== 'git' || this.mode !== 'gh') {
        return exec(binary, args, options);
      }
      return exec(binary, args, {
        ...options,
        gitConfig: [...(options?.gitConfig ?? []), ...GITHUB_GIT_CONFIG],
      });
    };
  }
}
