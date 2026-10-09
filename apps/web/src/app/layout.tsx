import { Toaster } from 'glass-ui/toast';
import type { Metadata } from 'next';
import { THEME_BOOTSTRAP_SCRIPT } from '../components/shell/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentDock',
  description: 'AgentDock',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // `data-theme` is set by the bootstrap script before first paint (spec D7),
    // so React must not render or reconcile it.
    <html lang="en" data-scale="desk" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: constant script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-ground text-ink">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
