import { useMemo } from 'react';
import { type DiffKind, diffLines, diffStat } from '../../../lib/tasks/diff';

const LINE_CLASS: Record<DiffKind, string> = {
  same: 'text-ink-2',
  added: 'bg-status-done-soft text-status-done-ink',
  removed: 'bg-status-error-soft text-status-error-ink',
};

const SIGN: Record<DiffKind, string> = { same: ' ', added: '+', removed: '−' };

/**
 * Two versions of the instructions, line by line. The sign is drawn as well as
 * the colour, so the diff reads without telling red from green.
 */
export function DiffView({
  before,
  after,
  label,
}: {
  before: string;
  after: string;
  label: string;
}) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const { added, removed } = diffStat(lines);

  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <p className="text-sm text-ink-2">
        {label}: <span className="num">+{added}</span>{' '}
        <span className="num">−{removed}</span>
        {added === 0 && removed === 0 ? ' — no difference' : null}
      </p>
      <pre className="m-0 max-h-96 overflow-auto rounded-lg border border-line bg-surface p-2 font-mono text-xs leading-5">
        {lines.map((line, index) => (
          <span
            // Lines repeat; the position is the identity of a diff row.
            // biome-ignore lint/suspicious/noArrayIndexKey: a diff is positional
            key={index}
            className={`block whitespace-pre-wrap break-words px-1 ${LINE_CLASS[line.kind]}`}
          >
            <span aria-hidden="true" className="select-none pe-2">
              {SIGN[line.kind]}
            </span>
            {line.text}
          </span>
        ))}
      </pre>
    </section>
  );
}
