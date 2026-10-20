import type { MetadataRoute } from 'next';

/**
 * The web app manifest (C-295): installed to a home screen, the app is named
 * Nautelle and wears the same mark as the tab. The colours mirror the dark
 * theme's ground, as `viewport.themeColor` does.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Nautelle',
    short_name: 'Nautelle',
    description:
      'Self-hosted control plane for Claude Code and Codex agent fleets.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0a1022',
    theme_color: '#0a1022',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  };
}
