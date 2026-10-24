'use client';

import { type ComponentType, useEffect, useState } from 'react';

export interface VideoPlayerProps {
  /** The attachment's `…/content` URL; the browser streams it with Range. */
  src: string;
  /** What the video shows, for assistive technology. */
  title: string;
}

/**
 * The luna-player implementation (C-371). luna-player ships its player
 * component in 0.2.0 and is not installable before that, so the loader fails
 * and `VideoPlayer` keeps the native element. When 0.2.0 lands, pin it exactly
 * and make this `import('luna-player').then((m) => m.Player)`.
 */
export const loadLunaPlayer: LunaLoader = () =>
  Promise.reject(new Error('luna-player is not installed'));

export type LunaLoader = () => Promise<ComponentType<VideoPlayerProps>>;

/** The fallback: a native `<video>`, which streams `src` with Range requests. */
export function NativeVideoPlayer({ src, title }: VideoPlayerProps) {
  return (
    // Demos are silent screen recordings: there is no speech to caption.
    // biome-ignore lint/a11y/useMediaCaption: silent screen recording
    <video
      className="aspect-video w-full rounded-md bg-black"
      src={src}
      title={title}
      aria-label={title}
      controls
      playsInline
      preload="metadata"
    />
  );
}

/**
 * The adapter the Demo section plays a recording with. It shows the native
 * player at once and swaps in Luna's when that loads; a Luna that fails to
 * load — not shipped yet, or a failed chunk — leaves the native one in place.
 */
export function VideoPlayer({
  src,
  title,
  loadLuna = loadLunaPlayer,
}: VideoPlayerProps & { loadLuna?: LunaLoader }) {
  const [Luna, setLuna] = useState<ComponentType<VideoPlayerProps> | null>(
    null,
  );

  useEffect(() => {
    let current = true;
    loadLuna()
      .then((component) => {
        if (current) setLuna(() => component);
      })
      .catch(() => {
        if (current) setLuna(null);
      });
    return () => {
      current = false;
    };
  }, [loadLuna]);

  return Luna ? (
    <Luna src={src} title={title} />
  ) : (
    <NativeVideoPlayer src={src} title={title} />
  );
}
