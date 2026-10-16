import { useEffect, useState } from 'react';

/** The visual viewport losing this much height means a soft keyboard is up. */
export const KEYBOARD_MIN_PX = 150;

/**
 * True when the visual viewport is shorter than the layout viewport by a
 * keyboard's worth. A pinch zoom shortens it too, so a scale off 1 is not a
 * keyboard.
 */
export const keyboardOpen = (
  layoutHeight: number,
  visualHeight: number,
  scale = 1,
) =>
  Math.abs(scale - 1) < 0.01 && layoutHeight - visualHeight > KEYBOARD_MIN_PX;

/** A soft keyboard comes up only for a field that takes text. */
const typesText = (element: Element | null) =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLElement && element.isContentEditable);

/**
 * #526: whether a soft keyboard covers the foot of the screen. The shell hides
 * its tab bar then, and `--keyboard-inset` (how much of the layout viewport
 * the keyboard covers, which iOS does not shrink) is set, so a docked action
 * such as Generate sits right above the keyboard.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return;
    const update = () => {
      const covered = window.innerHeight - visual.height - visual.offsetTop;
      const next =
        typesText(document.activeElement) &&
        keyboardOpen(window.innerHeight, visual.height, visual.scale);
      document.documentElement.style.setProperty(
        '--keyboard-inset',
        next ? `${Math.max(0, Math.round(covered))}px` : '0px',
      );
      setOpen(next);
    };
    update();
    visual.addEventListener('resize', update);
    visual.addEventListener('scroll', update);
    // The layout viewport changing alone raises no visual viewport event.
    window.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
      visual.removeEventListener('resize', update);
      visual.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (open) root.dataset.keyboard = 'open';
    else delete root.dataset.keyboard;
    return () => {
      delete root.dataset.keyboard;
    };
  }, [open]);
  return open;
}
