/**
 * #441: a design revision holds one or more named frames — each a separately
 * rendered HTML mockup: a whole page, one of its components, or another page
 * the task touches. The frames of a revision keep the order the turn drew
 * them in; a frame is addressed by its position (0-based).
 */

/** A frame's name, as the design turn writes it. */
export const DESIGN_FRAME_NAME_MAX = 60;

/**
 * The one frame of a revision stored before #441, which kept a single mockup;
 * also the frame of a turn that names none.
 */
export const DESIGN_LEGACY_FRAME_NAME = 'Mockup';

const FRAME_SLUG_MAX = 48;

/** A frame's file name stem: `Board page` → `board-page`. */
export const designFrameSlug = (name: string): string => {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, FRAME_SLUG_MAX)
    .replace(/-+$/, '');
  return slug || 'frame';
};

/**
 * The slugs of a revision's frames, in order and distinct: a slug already
 * taken gets `-2`, `-3`, … so two frames never publish to one file.
 */
export const designFrameSlugs = (names: readonly string[]): string[] => {
  const taken = new Set<string>();
  return names.map((name) => {
    const base = designFrameSlug(name);
    let slug = base;
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
    taken.add(slug);
    return slug;
  });
};

/** A frame the design turn drew: its name and its validated HTML. */
export interface DesignFrameDraft {
  name: string;
  html: string;
}
