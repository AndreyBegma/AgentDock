import { ImageResponse } from 'next/og';
import { LOGOMARK_DOT, LOGOMARK_PATH } from '../components/brand/logomark';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

/**
 * The home-screen icon, generated from the logomark at build time — no binary
 * in git. iOS fills transparency with black, so the tile sits on the dark
 * ground with its own padding; the colours are the dark theme's ink, the navy
 * ground and the accent (an image cannot read CSS variables).
 */
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0a1022',
      }}
    >
      <svg width="118" height="118" viewBox="0 0 32 32" aria-hidden="true">
        <path fill="#f2f2f6" fillRule="evenodd" d={LOGOMARK_PATH} />
        <circle {...LOGOMARK_DOT} fill="#5b5bf6" />
      </svg>
    </div>,
    size,
  );
}
