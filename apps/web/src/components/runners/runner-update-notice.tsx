import { Banner } from '@andrewbehma/glass-ui/banner';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import {
  type RunnerUpdateNotice as Notice,
  RUNNER_BREW_UPDATE_COMMAND,
  RUNNER_CHANGELOG_URL,
  RUNNER_RESTART_COMMANDS,
  runnerUpdateCommand,
} from '../../lib/runners/update';

/**
 * C-328: the user's own runner is behind the latest `nautelle-runner`
 * release — the command that installs it, how to restart the service, and
 * what changed. Dismissing it hides it until the next release.
 */
export function RunnerUpdateNotice({
  notice,
  onDismiss,
}: {
  notice: Notice;
  onDismiss: () => void;
}) {
  return (
    <Banner tone="info" title={notice.lines.join(' ')} onDismiss={onDismiss}>
      <div className="flex flex-col gap-2">
        <p>Update it on its machine:</p>
        <CodeBlock code={runnerUpdateCommand(notice.latest)} language="npm" />
        <p>then restart the service:</p>
        {RUNNER_RESTART_COMMANDS.map((item) => (
          <CodeBlock
            key={item.command}
            code={item.command}
            language={item.label}
          />
        ))}
        <p>
          Installed with Homebrew?{' '}
          <code className="font-mono text-ink">
            {RUNNER_BREW_UPDATE_COMMAND}
          </code>
        </p>
        <p>
          <a
            href={RUNNER_CHANGELOG_URL}
            target="_blank"
            rel="noreferrer"
            className="text-accent-ink underline underline-offset-2"
          >
            What&apos;s new in {notice.latest}
          </a>
        </p>
      </div>
    </Banner>
  );
}
