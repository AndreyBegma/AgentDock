import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Rule R1: why the control above is disabled, as the next step, under the
 * button row. Render it only for a reason that is not transient (not busy,
 * loading or refreshing). glass-ui `Button` ignores the pointer when disabled,
 * so a `Tooltip` on it never opens — this line is the reason instead.
 */
export function DisabledReason({
  children,
  href,
  cta,
  id,
}: {
  children: ReactNode;
  /** With `cta`: the page that removes the reason. */
  href?: string;
  cta?: string;
  /** Point the control's `aria-describedby` here. */
  id?: string;
}) {
  return (
    <p id={id} className="text-xs text-ink-2">
      {children}
      {href && cta ? (
        <>
          {' '}
          <Link href={href} className="text-ink underline underline-offset-2">
            {cta}
          </Link>
        </>
      ) : null}
    </p>
  );
}
