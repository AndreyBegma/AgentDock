// The Nautelle documentation site (ADR-0093). A static Starlight build,
// published to GitHub Pages by .woodpecker/release-docs.yml on a release tag.
// DOCS_SITE and DOCS_BASE move it to another host, e.g. `DOCS_BASE=/`.
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

const repo = 'https://github.com/AndreyBegma/Nautelle';

export default defineConfig({
  site: process.env.DOCS_SITE ?? 'https://andreybegma.github.io',
  base: process.env.DOCS_BASE ?? '/Nautelle',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Nautelle',
      description:
        'Self-hosted control plane for Claude Code agent fleets: install, configure, operate.',
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
        alt: 'Nautelle',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      editLink: { baseUrl: `${repo}/edit/develop/apps/docs/` },
      lastUpdated: false,
      sidebar: [
        {
          label: 'Getting started',
          items: [
            'getting-started/requirements',
            'getting-started/install',
            'getting-started/first-run',
            'getting-started/pair-a-runner',
            'getting-started/connect-a-project',
          ],
        },
        {
          label: 'Configuration',
          items: ['configuration/overview', 'configuration/environment'],
        },
        {
          label: 'Operations',
          items: [
            'operations/upgrade',
            'operations/backup',
            'operations/reverse-proxy',
            'operations/kubernetes',
            'operations/troubleshooting',
            'operations/privacy',
          ],
        },
        {
          label: 'Concepts',
          items: [
            'concepts/board',
            'concepts/stacks',
            'concepts/fleet',
            'concepts/runner-security',
          ],
        },
      ],
    }),
  ],
});
