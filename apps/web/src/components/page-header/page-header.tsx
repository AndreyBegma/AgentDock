import {
  PageHeader as GlassPageHeader,
  type PageHeaderProps,
} from '@andrewbehma/glass-ui/page-header';

export type { PageHeaderProps };

/**
 * The top of every page: glass-ui's `PageHeader` (#213) — eyebrow, 28 px h1,
 * `status` beside it, description, `meta` and `actions`. It keeps the gap to
 * the content below that this app's own header carried (#159), so a page that
 * passes no margin is spaced as before; glass-ui merges the classes, so a
 * page's `mb-0` or `mb-4` still wins.
 */
export function PageHeader({ className, ...props }: PageHeaderProps) {
  return <GlassPageHeader className={`mb-6 ${className ?? ''}`} {...props} />;
}
