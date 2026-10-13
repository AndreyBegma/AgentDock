import { Canvas } from '@andrewbehma/glass-ui/canvas';
import { Toaster } from '@andrewbehma/glass-ui/toast';
import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { THEME_BOOTSTRAP_SCRIPT } from '../components/shell/theme';
import './globals.css';

// glass-ui's `--font-sans` stack already names `var(--font-inter)` after SF
// Pro; `--font-mono` is mapped to the JetBrains Mono variable in globals.css.
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
});

export const metadata: Metadata = {
  title: { default: 'AgentDock', template: '%s · AgentDock' },
  description:
    'Self-hosted control plane for Claude Code and Codex agent fleets.',
  applicationName: 'AgentDock',
};

// The browser chrome takes the navy palette's ground (glass-ui#109): a meta
// tag cannot read a CSS variable, so these mirror `--color-ground`.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0a1022' },
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // `data-theme` is set by the bootstrap script before first paint (spec D7),
    // so React must not render or reconcile it.
    <html
      lang="en"
      data-scale="desk"
      data-palette="navy"
      className={`${inter.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: constant script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      {/* No background on body: `html` paints the ground under the canvas. */}
      <body className="min-h-screen font-sans text-ink antialiased">
        {/* The aurora behind every page, once, outside each `#main-content`:
            the depth effect transforms that element (glass-ui#93). */}
        <Canvas />
        {children}
        <Toaster />
      </body>
    </html>
  );
}
