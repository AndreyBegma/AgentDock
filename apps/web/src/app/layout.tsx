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

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#09090c' },
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
      className={`${inter.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: constant script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-ground font-sans text-ink antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
