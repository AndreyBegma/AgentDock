import { Card } from '@andrewbehma/glass-ui/card';
import type { ReactNode } from 'react';
import { Wordmark } from './brand';

/** The line under the wordmark on every page without a shell. */
export const TAGLINE =
  'The control plane for your Claude Code and Codex agent fleet.';

/**
 * The accent glow behind a public page's hero. Token colours only; it is
 * decoration, so it is hidden from readers and from the pointer.
 */
export function HeroGlow() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px] bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,color-mix(in_oklab,var(--color-accent)_16%,transparent),transparent)]"
    />
  );
}

/**
 * The centred, branded page shared by the unauthenticated pages (sign in,
 * register, pending), which have no shell (#159): the wordmark and the tagline
 * above the card, the card's own title as the page's h1.
 */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <main
      id="main-content"
      className="relative isolate flex min-h-screen w-full flex-col items-center px-4 py-10 sm:justify-center sm:py-16"
    >
      <HeroGlow />
      <div className="flex w-full max-w-sm flex-col gap-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <Wordmark size="lg" />
          <p className="max-w-xs text-[15px] text-ink-2">{TAGLINE}</p>
        </div>
        <Card pad="lg" className="flex flex-col gap-5">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {description ? (
              <p className="mt-1 text-sm text-ink-2">{description}</p>
            ) : null}
          </div>
          {children}
        </Card>
      </div>
    </main>
  );
}
