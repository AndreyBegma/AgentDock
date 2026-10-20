import { Logomark } from './logomark';

const SIZES = {
  sm: { mark: 18, text: 'text-sm', gap: 'gap-1.5' },
  md: { mark: 22, text: 'text-base', gap: 'gap-2' },
  lg: { mark: 36, text: 'text-2xl', gap: 'gap-3' },
} as const;

type WordmarkProps = {
  size?: keyof typeof SIZES;
  /** The agent's dot in the desk accent. */
  accent?: boolean;
  className?: string;
};

/** The mark and the name, as one accessible "Nautelle". */
export function Wordmark({
  size = 'md',
  accent = true,
  className = '',
}: WordmarkProps) {
  const s = SIZES[size];
  return (
    <span
      className={`inline-flex items-center ${s.gap} font-semibold tracking-tight text-ink ${s.text} ${className}`}
    >
      <Logomark size={s.mark} accent={accent} className="shrink-0" />
      <span>Nautelle</span>
    </span>
  );
}
