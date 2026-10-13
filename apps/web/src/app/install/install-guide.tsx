'use client';

import { PAIRING_CODE_TTL_MS, type PublicUser } from '@agentdock/shared';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import {
  CodeBlock,
  type CodeBlockProps,
} from '@andrewbehma/glass-ui/code-block';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import {
  ADD_RUNNER_PATH,
  installGuide,
  RUNNER_PLATFORMS,
  RUNNER_README_URL,
  RUNNER_REQUIREMENTS,
} from '../../lib/runners/install';

/** One string: an expression followed by text loses the space between them. */
const TTL = `${PAIRING_CODE_TTL_MS / 60_000} minutes`;

/** Who is reading: nobody signed in, a member, or an admin. Null until known. */
type Viewer = 'signed-out' | 'member' | 'admin';

function useViewer(): Viewer | null {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  useEffect(() => {
    api<PublicUser>('/auth/me')
      .then((user) => setViewer(user.role === 'admin' ? 'admin' : 'member'))
      .catch(() => setViewer('signed-out'));
  }, []);
  return viewer;
}

/** The page's origin, read after mount so the server render matches. */
function useOrigin(): string | null {
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  return origin;
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <Card
      pad="lg"
      className="flex flex-col gap-3"
      role="region"
      aria-labelledby={id}
    >
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      <div className="flex flex-col gap-3 text-sm text-ink-2">{children}</div>
    </Card>
  );
}

/** Wrapped by default: a phone shows the whole command, not a scroll. */
function Command(props: CodeBlockProps) {
  return <CodeBlock defaultWrap {...props} />;
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-ink">{children}</code>;
}

const linkClass = 'text-ink underline underline-offset-2';

/**
 * The public page about the runner (issue #145): what it is, how to install,
 * pair and keep it online, and what to check when it does not work. Every
 * command comes from `lib/runners/install.ts`.
 */
export function InstallGuide() {
  const origin = useOrigin();
  const viewer = useViewer();
  // The commands that do not depend on the origin are the same for any.
  const guide = installGuide(origin ?? '');

  return (
    <main
      id="main-content"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12"
    >
      <header className="flex flex-col gap-3">
        <p className="text-sm text-ink-3">AgentDock</p>
        <h1 className="text-2xl font-bold">Install the runner</h1>
        <p className="text-sm text-ink-2">
          Install it on the machine that holds your repositories, pair it with
          this server, and keep it online.
        </p>
        <div className="flex flex-wrap gap-2">
          {viewer === 'signed-out' ? (
            <Link
              href="/login"
              className={buttonClassName({ variant: 'glass', size: 'sm' })}
            >
              Sign in
            </Link>
          ) : null}
          {viewer === 'member' || viewer === 'admin' ? (
            <Link
              href="/"
              className={buttonClassName({ variant: 'glass', size: 'sm' })}
            >
              Back to AgentDock
            </Link>
          ) : null}
        </div>
      </header>

      <Section id="what" title="What the runner is">
        <p>
          The runner is the AgentDock daemon on the machine that holds your
          repositories and agents. AgentDock never reads your files itself: the
          runner does, and it runs the agents. It connects out to this server,
          so the machine needs no open port.
        </p>
        <p>It looks for these on its machine:</p>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {RUNNER_REQUIREMENTS.map((item) => (
            <li key={item.tool}>
              <span className="text-ink">{item.tool}</span> — {item.why}
            </li>
          ))}
        </ul>
      </Section>

      <Section id="install" title="Install">
        <p>Prebuilt for {RUNNER_PLATFORMS.join(', ')}. Pick one of:</p>
        {guide.install.map((item) => (
          <Command
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
            className={linkClass}
          >
            Build it from source
          </a>
          . Then check the install:
        </p>
        <Command code={guide.version} />
      </Section>

      <Section id="pair" title="Pair it with this server">
        <p>
          An administrator creates a pairing code in Admin → Runners → Add
          runner. The code works once and is valid for {TTL}. Run this on the
          runner&apos;s machine with that code:
        </p>
        {origin ? (
          <>
            <Command code={guide.pair} />
            <p>
              The machine must reach <Mono>{guide.server}</Mono>.
            </p>
          </>
        ) : (
          <p aria-live="polite">Reading this server&apos;s address…</p>
        )}
        {viewer === 'admin' ? (
          <div>
            <Link
              href={ADD_RUNNER_PATH}
              className={buttonClassName({ variant: 'solid', size: 'sm' })}
            >
              Add runner
            </Link>
          </div>
        ) : null}
      </Section>

      <Section id="keep-online" title="Keep it running">
        <p>
          Run it as a service so it survives logouts and reboots. Which command
          depends on how you installed it:
        </p>
        {guide.keepOnline.map((item) => (
          <Command
            key={item.command}
            code={item.command}
            language={item.label}
          />
        ))}
        <p>
          With npm, <Mono>install-service</Mono> writes a systemd user unit on
          Linux and a launchd agent on macOS, and prints the command that starts
          it. To run it in the foreground instead:
        </p>
        <Command code={guide.run} />
      </Section>

      <Section id="profiles" title="Profiles">
        <p>
          A runtime profile is how to launch a runtime on a runner: binary,
          environment (<Mono>CLAUDE_CONFIG_DIR</Mono>, <Mono>CODEX_HOME</Mono>
          ), extra args. Pairing detects them when the runner has none; to
          detect and store them again:
        </p>
        <Command code={guide.profiles} />
      </Section>

      <Section id="troubleshooting" title="Troubleshooting">
        <dl className="flex flex-col gap-3">
          <div>
            <dt className="font-medium text-ink">The runner shows offline</dt>
            <dd>
              It is paired but not running. Start it on its machine, as in Keep
              it running.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink">The pairing code expired</dt>
            <dd>
              Codes last {TTL}. An administrator generates a new one from the
              runner in Admin → Runners.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink">
              <Mono>command not found</Mono>
            </dt>
            <dd>
              The install directory is not on your <Mono>PATH</Mono>. With npm,
              add the global bin (<Mono>{guide.npmPrefix}</Mono>, then its{' '}
              <Mono>bin</Mono>) to <Mono>PATH</Mono>.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink">macOS refuses the binary</dt>
            <dd>
              Install it with Homebrew: that is the supported way on macOS.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink">
              The server is not reachable from the machine
            </dt>
            <dd className="flex flex-col gap-2">
              <span>
                Check that this answers from the runner&apos;s machine:
              </span>
              {origin ? <Command code={guide.healthCheck} /> : null}
            </dd>
          </div>
        </dl>
      </Section>
    </main>
  );
}
