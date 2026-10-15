'use client';

import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import Link from 'next/link';

/**
 * A workspace page that threw while rendering (#213). The shell stays, so the
 * rail, the palette and every other page still work; Try again re-renders the
 * page. The digest names the failure for the server log, never the stack.
 */
export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <SectionUnavailable
      title="This page could not be shown"
      stillWorks="The navigation and every other page still work."
      detail={error.digest ? `Error ${error.digest}` : undefined}
      action={
        <div className="flex flex-wrap gap-2">
          <Button variant="glass" size="sm" onClick={reset}>
            Try again
          </Button>
          <Link
            href="/"
            className={buttonClassName({ variant: 'ghost', size: 'sm' })}
          >
            Back to Overview
          </Link>
        </div>
      }
    />
  );
}
