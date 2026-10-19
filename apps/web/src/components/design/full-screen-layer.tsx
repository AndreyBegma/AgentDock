'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  PHONE_BACK_BAR_CLEARANCE,
  PhoneBackBar,
} from '../shell/phone-back-bar';

type LayerProps = {
  label: string;
  children: ReactNode;
  /** Kept mounted but not shown, so what is typed in it survives a close. */
  hidden?: boolean;
  /** Leaving goes up to a parent: the phone bar shows Back. Wins over `onClose`. */
  onBack?: () => void;
  /** Leaving dismisses a layer with no parent: the phone bar shows Close. */
  onClose?: () => void;
  /** The phone bar's destination word, title, subtitle and one action. */
  bar?: {
    label?: string;
    title?: ReactNode;
    subtitle?: ReactNode;
    action?: ReactNode;
  };
};

/**
 * The layer itself, without the portal. With `onBack` or `onClose` it draws
 * the phone back bar (below `lg` only) and pads its end so nothing hides
 * under it; without either it is unchanged.
 */
export function FullScreenLayerFrame({
  label,
  children,
  onBack,
  onClose,
  bar,
  hidden,
}: LayerProps) {
  const onExit = onBack ?? onClose;
  return (
    <section
      aria-label={label}
      hidden={hidden}
      className={`fixed inset-0 z-[calc(var(--z-index-chrome)+1)] flex flex-col bg-ground text-ink${
        onExit ? ` ${PHONE_BACK_BAR_CLEARANCE}` : ''
      }`}
    >
      {children}
      {onExit ? (
        <PhoneBackBar
          kind={onBack ? 'back' : 'close'}
          label={bar?.label}
          title={bar?.title}
          subtitle={bar?.subtitle}
          action={bar?.action}
          onExit={onExit}
        />
      ) : null}
    </section>
  );
}

/**
 * A full-screen layer over the shell. glass-ui's depth effect pushes
 * `#main-content` back when a sheet or dialog opens, and a transformed
 * ancestor turns `position: fixed` into "fixed to that ancestor" — so a
 * full-screen page must live outside it (glass-ui `base.css`'s contract).
 * It mounts in `document.body` after hydration; the server renders nothing.
 */
export function FullScreenLayer(props: LayerProps) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);
  if (!host) return null;
  return createPortal(<FullScreenLayerFrame {...props} />, host);
}
