import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ScrollX } from '../scroll-x/scroll-x';
import { isExternal, safeHref } from './safe-href';

type MarkdownProps = {
  /** Markdown source: a checkpoint, an outcome, a brief. */
  children: string | null | undefined;
  /** Tighter spacing, for a feed row or a table cell. */
  compact?: boolean;
  className?: string;
};

const textOf = (node: ReactNode): string =>
  typeof node === 'string'
    ? node
    : Array.isArray(node)
      ? node.map(textOf).join('')
      : '';

/**
 * Headings are demoted and sized down: a checkpoint's `# Plan` must never
 * outrank the page's own h1, nor shout louder than it.
 */
const heading =
  (Tag: 'h3' | 'h4' | 'h5', size: string) =>
  ({ children }: { children?: ReactNode }) => (
    <Tag className={`mt-4 mb-1.5 font-semibold text-ink first:mt-0 ${size}`}>
      {children}
    </Tag>
  );

const COMPONENTS: Components = {
  h1: heading('h3', 'text-base'),
  h2: heading('h4', 'text-sm'),
  h3: heading('h5', 'text-sm'),
  h4: heading('h5', 'text-sm'),
  h5: heading('h5', 'text-sm'),
  h6: heading('h5', 'text-sm'),
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  a: ({ href, children }) => {
    const target = safeHref(href);
    if (!target) return <span>{children}</span>;
    const external = isExternal(target);
    return (
      <a
        href={target}
        className="text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
        {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
      >
        {children}
      </a>
    );
  },
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 marker:text-ink-3">
      {children}
    </ul>
  ),
  ol: ({ children, start }) => (
    <ol
      start={start}
      className="my-2 list-decimal space-y-1 pl-5 marker:text-ink-3"
    >
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-ink-2">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-line" />,
  // Fenced code is a `pre > code`: `pre` hands it to CodeBlock whole, so the
  // `code` renderer below only ever sees inline code.
  pre: ({ children }) => {
    const child = Array.isArray(children) ? children[0] : children;
    const props = (
      child as { props?: { className?: string; children?: ReactNode } }
    )?.props;
    const language = /language-([\w-]+)/.exec(props?.className ?? '')?.[1];
    const code = textOf(props?.children).replace(/\n$/, '');
    return (
      <div className="my-2">
        <CodeBlock code={code} language={language} maxHeight={360} />
      </div>
    );
  },
  code: ({ children }) => (
    <code className="rounded bg-raised px-1 py-px font-mono text-[0.9em]">
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="my-2">
      <ScrollX edgeClassName="from-surface">
        <Table>{children}</Table>
      </ScrollX>
    </div>
  ),
  thead: ({ children }) => <TableHead>{children}</TableHead>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children }) => <TableCell head>{children}</TableCell>,
  td: ({ children }) => <TableCell>{children}</TableCell>,
  img: ({ alt, src }) => {
    const target = typeof src === 'string' ? safeHref(src) : null;
    return target ? (
      <a href={target} target="_blank" rel="noreferrer noopener">
        {alt || target}
      </a>
    ) : (
      <span>{alt}</span>
    );
  },
};

/**
 * Agent-written markdown, rendered safely: raw HTML is shown as text (no
 * `rehype-raw`), links pass `safeHref`, bare URLs become links (GFM), fenced
 * code is glass-ui's `CodeBlock`, tables scroll inside `ScrollX`.
 */
export function Markdown({ children, compact, className = '' }: MarkdownProps) {
  if (!children?.trim()) return null;
  return (
    <div
      className={`min-w-0 break-words text-ink ${compact ? 'text-sm leading-snug' : 'text-sm leading-relaxed'} ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={COMPONENTS}
        skipHtml
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
