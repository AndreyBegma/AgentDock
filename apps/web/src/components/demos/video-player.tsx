'use client';

import { type ComponentType, useEffect, useState } from 'react';

export interface VideoPlayerProps {
  /** The attachment's `…/content` URL; the browser streams it with Range. */
  src: string;
  /** What the video shows, for assistive technology. */
  title: string;
}

/** What the adapter asks of a player component: ours plus a failure signal. */
export interface LunaPlayerProps extends VideoPlayerProps {
  /** The player could not play `src`; the adapter falls back to native. */
  onError?: () => void;
}

export type LunaLoader = () => Promise<ComponentType<LunaPlayerProps>>;

/**
 * The luna-player implementation (ADR-0090 §7). The dynamic import keeps the
 * player out of the main bundle, and `luna-player/hls` is never imported, so
 * hls.js stays out too: demos are progressive MP4/WebM. `storage={null}` keeps
 * the player from writing preferences to localStorage on the card.
 */
export const loadLunaPlayer: LunaLoader = async () => {
  const { Player } = await import('luna-player/player');
  return function LunaPlayer({ src, title, onError }: LunaPlayerProps) {
    return (
      <Player
        src={src}
        title={title}
        aspectRatio="16:9"
        storage={null}
        onError={() => onError?.()}
      />
    );
  };
};

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
 * Which player shows: Luna's while it is loaded and has not failed on this
 * source, the native one otherwise. A playback error is per source, so a new
 * recording gets Luna again.
 */
export function PlayerSwitch({
  Luna,
  failedSrc,
  onFail,
  src,
  title,
}: VideoPlayerProps & {
  Luna: ComponentType<LunaPlayerProps> | null;
  failedSrc: string | null;
  onFail: (src: string) => void;
}) {
  return Luna && failedSrc !== src ? (
    <Luna src={src} title={title} onError={() => onFail(src)} />
  ) : (
    <NativeVideoPlayer src={src} title={title} />
  );
}

/**
 * The adapter the Demo section plays a recording with. It shows the native
 * player at once and swaps in Luna's when that loads; a Luna that fails to
 * load, or reports a playback error, leaves the native one in place.
 */
export function VideoPlayer({
  src,
  title,
  loadLuna = loadLunaPlayer,
}: VideoPlayerProps & { loadLuna?: LunaLoader }) {
  const [Luna, setLuna] = useState<ComponentType<LunaPlayerProps> | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

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

  return (
    <PlayerSwitch
      Luna={Luna}
      failedSrc={failedSrc}
      onFail={setFailedSrc}
      src={src}
      title={title}
    />
  );
}
