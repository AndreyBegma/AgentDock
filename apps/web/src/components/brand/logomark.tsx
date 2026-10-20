/**
 * The Nautelle mark, a placeholder until the real logo arrives (C-295): a
 * sailboat — mainsail, jib and hull — on the rounded tile, with the live
 * agent's dot as the sun. Drawn on a 32-unit grid; the boat and the dot are
 * cut out of the tile (even-odd), so the mark is one colour — `currentColor` —
 * on any surface. `app/icon.svg` and `app/apple-icon.png` are the same
 * geometry.
 */
export const LOGOMARK_PATH =
  'M10 2h12a8 8 0 0 1 8 8v12a8 8 0 0 1-8 8H10a8 8 0 0 1-8-8V10a8 8 0 0 1 8-8z' +
  'M14.5 6v14H7z' +
  'M16.5 9.5V20h6z' +
  'M7 22h18l-2.5 3.5h-13z' +
  'M20 8.25a2.25 2.25 0 1 0 4.5 0a2.25 2.25 0 1 0-4.5 0z';

/** The agent's dot, filled with the accent when the mark asks for it. */
export const LOGOMARK_DOT = { cx: 22.25, cy: 8.25, r: 2.25 } as const;

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
      {accent ? <circle {...LOGOMARK_DOT} fill="var(--color-accent)" /> : null}
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
