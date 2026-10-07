import type {
  CommandErrorCode,
  ProjectInspection,
} from '@agentdock/shared/protocol';
import { TestRunnerSocket } from '../../runners/testing/runner-e2e';

export const ROOT = '/srv/dev/widget';

/** What a runner reports for a GitHub main checkout with in-repo docs. */
export const inspection = (
  overrides: Partial<ProjectInspection> = {},
): ProjectInspection => ({
  root: ROOT,
  gitCommonDir: `${ROOT}/.git`,
  isMainCheckout: true,
  remote: {
    url: 'git@github.com:acme/widget.git',
    forge: 'github',
    repo: 'acme/widget',
  },
  baseBranch: 'develop',
  baseSource: 'config',
  codeSentinelConfig: { orchestrator: { base: 'develop' } },
  hasClaudeMd: true,
  hasAgentsMd: false,
  docs: {
    kind: 'in_repo',
    localPath: `${ROOT}/docs`,
    repo: 'acme/widget',
    isGitRepo: true,
    detectedBy: 'in_repo',
    evidence: [{ file: `${ROOT}/docs` }],
    classified: { specs: ['specs'], adr: ['adr'], roadmap: [], reports: [] },
    candidates: [
      { rule: 'spec_dir', target: `${ROOT}/docs/specs`, hit: false },
      { rule: 'in_repo', target: `${ROOT}/docs`, hit: true },
    ],
  },
  warnings: [],
  ...overrides,
});

export type Answer =
  | { ok: true; output: ProjectInspection }
  | { ok: false; code: CommandErrorCode; message?: string }
  | 'silence';

export interface ReceivedCommand {
  name: string;
  args: unknown;
}

/**
 * A connected fake runner that answers every command with `answer` (default:
 * the inspection above) and remembers what it was asked.
 */
export class FakeRunner {
  readonly received: ReceivedCommand[] = [];
  answer: (command: ReceivedCommand) => Answer = () => ({
    ok: true,
    output: inspection(),
  });

  constructor(readonly socket: TestRunnerSocket) {
    void this.serve();
  }

  private async serve(): Promise<void> {
    for (;;) {
      let command: Awaited<ReturnType<TestRunnerSocket['next']>>;
      try {
        command = await this.socket.next('command', 60_000);
      } catch {
        return;
      }
      const received = { name: command.name, args: command.args };
      this.received.push(received);
      const answer = this.answer(received);
      if (answer === 'silence') continue;
      this.socket.send(
        answer.ok
          ? {
              type: 'command.result',
              id: command.id,
              ok: true,
              output: answer.output,
            }
          : {
              type: 'command.result',
              id: command.id,
              ok: false,
              error: { code: answer.code, message: answer.message },
            },
      );
    }
  }
}
