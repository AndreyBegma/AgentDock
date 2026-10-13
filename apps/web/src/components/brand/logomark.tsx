/**
 * The AgentDock mark: a dock (the rounded tile) holding a fleet of slots, the
 * last one carrying the live agent's dot. Drawn on a 32-unit grid so every
 * edge lands on a half pixel at 16 px; the slots and the dot are cut out of
 * the tile (even-odd), so the mark is one colour — `currentColor` — on any
 * surface. `app/icon.svg` and `app/apple-icon.png` are the same geometry.
 */
export const LOGOMARK_PATH =
  'M10 2h12a8 8 0 0 1 8 8v12a8 8 0 0 1-8 8H10a8 8 0 0 1-8-8V10a8 8 0 0 1 8-8z' +
  'M9.75 9h12.5a1.75 1.75 0 0 1 0 3.5H9.75a1.75 1.75 0 0 1 0-3.5z' +
  'M9.75 14.25h7.5a1.75 1.75 0 0 1 0 3.5h-7.5a1.75 1.75 0 0 1 0-3.5z' +
  'M9.75 19.5h3.5a1.75 1.75 0 0 1 0 3.5h-3.5a1.75 1.75 0 0 1 0-3.5z' +
  'M18.5 21.25a2.75 2.75 0 1 0 5.5 0a2.75 2.75 0 1 0-5.5 0z';

type LogomarkProps = {
  /** Rendered width and height in px. */
  size?: number;
  /** Fill the agent's dot with the desk accent instead of leaving it cut out. */
  accent?: boolean;
  className?: string;
  /** An accessible name; omitted, the mark is decorative (next to a wordmark). */
  title?: string;
};

export function Logomark({
  size = 24,
  accent = false,
  className,
  title,
}: LogomarkProps) {
  const shape = (
    <>
      <path fill="currentColor" fillRule="evenodd" d={LOGOMARK_PATH} />
      {accent ? (
        <circle cx="21.25" cy="21.25" r="2.75" fill="var(--color-accent)" />
      ) : null}
    </>
  );
  return title ? (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
    >
      <title>{title}</title>
      {shape}
    </svg>
  ) : (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
    >
      {shape}
    </svg>
  );
}
