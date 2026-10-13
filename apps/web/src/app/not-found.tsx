import { buttonClassName } from '@andrewbehma/glass-ui/button';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Wordmark } from '../components/brand';

export const metadata: Metadata = { title: 'Page not found' };

/**
 * Any path nothing answers (#159). It renders without the shell, signed in or
 * not, so it carries the brand itself and offers the way back.
 */
export default function NotFound() {
  return (
    <main
      id="main-content"
      className="flex min-h-screen w-full flex-col items-center justify-center gap-8 px-4 py-16 text-center"
    >
      <Link href="/" aria-label="AgentDock, overview">
        <Wordmark size="lg" />
      </Link>
      <div className="flex max-w-md flex-col items-center gap-3">
        <p className="font-mono text-sm text-ink-3">404</p>
        <h1 className="text-[28px] leading-[1.15] font-semibold tracking-tight">
          Page not found
        </h1>
        <p className="text-[15px] text-ink-2">
          The link may be old, or the project, run or session it pointed at was
          removed.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Link href="/" className={buttonClassName({ variant: 'solid' })}>
          Back to Overview
        </Link>
        <Link
          href="/projects"
          className={buttonClassName({ variant: 'glass' })}
        >
          Projects
        </Link>
      </div>
    </main>
  );
}
