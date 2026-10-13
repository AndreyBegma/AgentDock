import { ImageResponse } from 'next/og';
import { LOGOMARK_PATH } from '../components/brand/logomark';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

/**
 * The home-screen icon, generated from the logomark at build time — no binary
 * in git. iOS fills transparency with black, so the tile sits on the dark
 * ground with its own padding; the colours are the dark theme's ink, ground
 * and desk accent (an image cannot read CSS variables).
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
        background: '#09090c',
      }}
    >
      <svg width="118" height="118" viewBox="0 0 32 32" aria-hidden="true">
        <path fill="#f2f2f6" fillRule="evenodd" d={LOGOMARK_PATH} />
        <circle cx="21.25" cy="21.25" r="2.75" fill="#806ffc" />
      </svg>
    </div>,
    size,
  );
}
