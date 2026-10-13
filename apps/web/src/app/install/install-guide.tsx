'use client';

import { PAIRING_CODE_TTL_MS, type PublicUser } from '@agentdock/shared';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import {
  CodeBlock,
  type CodeBlockProps,
} from '@andrewbehma/glass-ui/code-block';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import {
  FolderLock,
  GitBranch,
  type LucideIcon,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { SiteLink, Wordmark } from '../../components/brand';
import { api } from '../../lib/api';
import {
  ADD_RUNNER_PATH,
  installGuide,
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

type Os = 'macos' | 'linux';
type Method = 'Homebrew' | 'npm' | 'Bun';

/** The prebuilt targets per system (ADR-0017), and the way that works best there. */
const SYSTEMS: Record<Os, { label: string; arch: string; method: Method }> = {
  macos: {
    label: 'macOS',
    arch: 'Apple silicon and Intel',
    method: 'Homebrew',
  },
  linux: { label: 'Linux', arch: 'arm64 and x64', method: 'npm' },
};

const METHODS: readonly Method[] = ['Homebrew', 'npm', 'Bun'];

const VALUE: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: FolderLock,
    title: 'Your code stays put',
    text: 'AgentDock never reads your files. The runner does, on its own machine.',
  },
  {
    icon: ShieldCheck,
    title: 'No open port',
    text: 'It connects out to this server, so the machine needs no inbound access.',
  },
  {
    icon: GitBranch,
    title: 'One run, one worktree',
    text: 'Every agent gets its own git worktree and tmux session.',
  },
];

/** Wrapped by default: a phone shows the whole command, not a scroll. */
function Command(props: CodeBlockProps) {
  return <CodeBlock defaultWrap {...props} />;
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[0.92em] text-ink">{children}</code>;
}

const linkClass = 'text-ink underline underline-offset-2';

/** A pressed-state choice: the OS and the install method. */
function Choice<T extends string>({
  label,
  layoutId,
  options,
  value,
  onChange,
  render,
}: {
  label: string;
  layoutId: string;
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  render: (option: T) => ReactNode;
}) {
  return (
    <SegmentedControl
      role="group"
      aria-label={label}
      className="w-full sm:w-fit"
    >
      {options.map((option) => (
        <SegmentedControlItem
          key={option}
          active={value === option}
          layoutId={layoutId}
        >
          <button
            type="button"
            aria-pressed={value === option}
            onClick={() => onChange(option)}
            className={`relative w-full px-4 py-1.5 text-sm ${value === option ? '' : 'text-ink-2 hover:text-ink'}`}
          >
            {render(option)}
          </button>
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

/** One numbered step, with the rail that joins it to the next. */
function Step({
  n,
  id,
  title,
  last = false,
  children,
}: {
  n: number;
  id: string;
  title: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="relative flex gap-4 sm:gap-6">
      <div className="flex flex-col items-center">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line-strong bg-raised text-sm font-semibold tabular-nums text-ink"
        >
          {n}
        </span>
        {last ? null : (
          <span aria-hidden="true" className="mt-2 w-px flex-1 bg-line" />
        )}
      </div>
      <div
        className={`flex min-w-0 flex-1 flex-col gap-3 ${last ? '' : 'pb-10'}`}
      >
        <h3
          id={id}
          className="pt-0.5 text-lg font-semibold tracking-tight text-ink"
        >
          <span className="sr-only">Step {n}: </span>
          {title}
        </h3>
        <div className="flex flex-col gap-3 text-[15px] leading-relaxed text-ink-2">
          {children}
        </div>
      </div>
    </li>
  );
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
      <h2 id={id} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      <div className="flex flex-col gap-3 text-[15px] leading-relaxed text-ink-2">
        {children}
      </div>
    </Card>
  );
}

/**
 * The public page about the runner (issues #145, #159): what it is and why,
 * then the system, then three numbered steps — install, pair, keep running —
 * and the reference below. Every command comes from `lib/runners/install.ts`.
 */
export function InstallGuide() {
  const origin = useOrigin();
  const viewer = useViewer();
  const [os, setOs] = useState<Os>('macos');
  const [method, setMethod] = useState<Method>(SYSTEMS.macos.method);
  // The commands that do not depend on the origin are the same for any.
  const guide = installGuide(origin ?? '');

  const chooseOs = (next: Os) => {
    setOs(next);
    setMethod(SYSTEMS[next].method);
  };
  const install = guide.install.find((item) => item.label === method);
  // Homebrew runs it as a brew service; the npm package (from npm or Bun)
  // writes its own unit with `install-service` (ADR-0017).
  const keepOnline =
    guide.keepOnline[method === 'Homebrew' ? 0 : 1] ?? guide.keepOnline[0];

  return (
    // The canvas behind the page is the root layout's; the column is the main.
    <div>
      <main
        id="main-content"
        className="mx-auto flex w-full max-w-3xl flex-col gap-12 px-4 pb-16 pt-6 sm:px-6 sm:pt-8"
      >
        <nav
          aria-label="AgentDock"
          className="flex items-center justify-between gap-3"
        >
          <Link
            href={viewer === 'signed-out' ? '/login' : '/'}
            aria-label="AgentDock"
          >
            <Wordmark size="md" />
          </Link>
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
        </nav>

        <header className="flex flex-col items-start gap-5 sm:pt-6">
          <p className="text-sm font-medium text-ink-3">The AgentDock runner</p>
          <h1 className="text-[34px] leading-[1.1] font-semibold tracking-tight text-ink sm:text-[44px]">
            Run your agents on your own machine.
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-ink-2 sm:text-lg">
            The runner is a small daemon for the machine that holds your
            repositories. It starts Claude Code and Codex agents there, and
            reports to this server. Three steps: install it, pair it, keep it
            running.
          </p>
          <ul className="grid w-full gap-3 pt-2 sm:grid-cols-3">
            {VALUE.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex flex-col gap-1.5">
                <Icon size={18} aria-hidden="true" className="text-ink" />
                <span className="text-[15px] font-medium text-ink">
                  {title}
                </span>
                <span className="text-sm leading-relaxed text-ink-2">
                  {text}
                </span>
              </li>
            ))}
          </ul>
        </header>

        <section aria-labelledby="setup" className="flex flex-col gap-8">
          <div className="flex flex-col gap-4">
            <h2 id="setup" className="text-2xl font-semibold tracking-tight">
              Set it up
            </h2>
            <Choice
              label="Your system"
              layoutId="install-os"
              options={['macos', 'linux'] as const}
              value={os}
              onChange={chooseOs}
              render={(option) => SYSTEMS[option].label}
            />
            <p className="text-sm text-ink-3">
              Prebuilt for {SYSTEMS[os].label} on {SYSTEMS[os].arch}.
            </p>
          </div>

          <ol className="flex flex-col">
            <Step n={1} id="install" title="Install">
              <p>It needs these on the machine:</p>
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {RUNNER_REQUIREMENTS.map((item) => (
                  <li key={item.tool}>
                    <span className="text-ink">{item.tool}</span> — {item.why}
                  </li>
                ))}
              </ul>
              <p>Then install the runner with:</p>
              <Choice
                label="Install with"
                layoutId="install-method"
                options={METHODS}
                value={method}
                onChange={setMethod}
                render={(option) => option}
              />
              {install ? (
                <Command code={install.command} language={install.label} />
              ) : null}
              {os === 'macos' && method !== 'Homebrew' ? (
                <p className="text-sm">
                  On macOS, Homebrew is the supported way: macOS can refuse a
                  binary installed any other way.
                </p>
              ) : null}
              <p>Check that it is on your path:</p>
              <Command code={guide.version} />
              <p className="text-sm">
                No prebuilt binary for your machine?{' '}
                <a
                  href={RUNNER_README_URL}
                  target="_blank"
                  rel="noreferrer"
                  className={linkClass}
                >
                  Build it from source
                </a>
                .
              </p>
            </Step>

            <Step n={2} id="pair" title="Pair it with this server">
              <p>
                An administrator creates a pairing code in Admin → Runners → Add
                runner. The code works once and is valid for {TTL}. On the
                runner&apos;s machine, run this with that code:
              </p>
              {origin ? (
                <>
                  <Command code={guide.pair} />
                  <p className="text-sm">
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
                    className={buttonClassName({
                      variant: 'solid',
                      size: 'sm',
                    })}
                  >
                    Add runner
                  </Link>
                </div>
              ) : null}
            </Step>

            <Step n={3} id="keep-online" title="Keep it running" last>
              <p>
                Run it as a service, so it survives logouts and reboots
                {method === 'Homebrew'
                  ? ' (a Homebrew service):'
                  : ' (a systemd user unit on Linux, a launchd agent on macOS):'}
              </p>
              <Command code={keepOnline.command} language={keepOnline.label} />
              <p>To run it in the foreground instead:</p>
              <Command code={guide.run} />
            </Step>
          </ol>
        </section>

        <div className="flex flex-col gap-4">
          <Section id="profiles" title="Profiles">
            <p>
              A runtime profile is how to launch a runtime on a runner: binary,
              environment (<Mono>CLAUDE_CONFIG_DIR</Mono>,{' '}
              <Mono>CODEX_HOME</Mono>
              ), extra args. Pairing detects them when the runner has none; to
              detect and store them again:
            </p>
            <Command code={guide.profiles} />
          </Section>

          <Section id="troubleshooting" title="Troubleshooting">
            <dl className="flex flex-col gap-4">
              <div>
                <dt className="font-medium text-ink">
                  The runner shows offline
                </dt>
                <dd>
                  It is paired but not running. Start it on its machine, as in
                  Keep it running.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">
                  The pairing code expired
                </dt>
                <dd>
                  Codes last {TTL}. An administrator generates a new one from
                  the runner in Admin → Runners.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">
                  <Mono>command not found</Mono>
                </dt>
                <dd>
                  The install directory is not on your <Mono>PATH</Mono>. With
                  npm, add the global bin (<Mono>{guide.npmPrefix}</Mono>, then
                  its <Mono>bin</Mono>) to <Mono>PATH</Mono>.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">
                  macOS refuses the binary
                </dt>
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
        </div>
        <SiteLink />
      </main>
    </div>
  );
}
