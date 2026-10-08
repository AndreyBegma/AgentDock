import { Spinner } from 'glass-ui/spinner';

/** A spinner with the sentence of the command still in flight. */
export function PendingLabel({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-ink-2">
      <Spinner size="sm" label={label} />
      {label}
    </span>
  );
}
