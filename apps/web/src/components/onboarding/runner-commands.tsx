'use client';

import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import Link from 'next/link';
import {
  INSTALL_COMMANDS,
  INSTALL_PATH,
  KEEP_ONLINE_COMMANDS,
  RUN_COMMAND,
  RUNNER_README_URL,
} from '../../lib/runners/install';

/** The public page with every step and the troubleshooting (issue #145). */
export function InstallGuideLink({
  children = 'Full install guide and troubleshooting',
}: {
  children?: string;
}) {
  return (
    <p>
      <Link
        href={INSTALL_PATH}
        className="text-ink underline underline-offset-2"
      >
        {children}
      </Link>
    </p>
  );
}

/** Homebrew or npm, and where to build from source. */
export function InstallCommands() {
  return (
    <>
      {INSTALL_COMMANDS.map((item) => (
        <CodeBlock
          key={item.command}
          code={item.command}
          language={item.label}
        />
      ))}
      <p>
        Neither available?{' '}
        <a
          href={RUNNER_README_URL}
          target="_blank"
          rel="noreferrer"
          className="text-ink underline underline-offset-2"
        >
          Build it from source
        </a>
        .
      </p>
    </>
  );
}

/** Start it now, and keep it running as a service by install method (ADR-0017). */
export function KeepOnlineCommands() {
  return (
    <>
      <CodeBlock code={RUN_COMMAND} />
      <p>
        Or keep it running across logouts and reboots. With npm,{' '}
        <code className="font-mono text-ink">install-service</code> writes a
        systemd unit (Linux) or a launchd agent (macOS) and prints the command
        that starts it:
      </p>
      {KEEP_ONLINE_COMMANDS.map((item) => (
        <CodeBlock
          key={item.command}
          code={item.command}
          language={item.label}
        />
      ))}
    </>
  );
}
