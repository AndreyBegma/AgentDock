import type { ReactNode } from 'react';

type PageHeaderProps = {
  /** The page's h1. A node, so a status badge can sit beside the name. */
  title: ReactNode;
  /** One or two sentences under the title: what this page is for. */
  description?: ReactNode;
  /** Primary and secondary actions, right-aligned; wrap below on a phone. */
  actions?: ReactNode;
  /** A small line above the title: the parent entity, a kind ("Run", "Slot"). */
  eyebrow?: ReactNode;
  /** The h1's id, for `aria-labelledby` on the page's main region. */
  id?: string;
  className?: string;
};

/**
 * The top of every page (issue #159): one h1 at 28 px, semibold, tight
 * tracking; the description in the secondary ink; the actions on the right.
 * Sibling screens use this instead of a hand-written `<h1>` row.
 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  id,
  className = '',
}: PageHeaderProps) {
  return (
    <header
      className={`mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-6 ${className}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow ? (
          <div className="text-xs font-medium text-ink-3">{eyebrow}</div>
        ) : null}
        <h1
          id={id}
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[28px] leading-[1.15] font-semibold tracking-tight text-ink"
        >
          {title}
        </h1>
        {description ? (
          <p className="max-w-prose text-sm text-ink-2">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
