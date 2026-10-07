import { Toaster } from 'glass-ui/toast';
import type { Metadata } from 'next';
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
    <html lang="en" data-scale="desk" data-theme="dark">
      <body className="min-h-screen bg-ground text-ink">
        <main id="main-content" className="mx-auto w-full max-w-4xl p-6">
          {children}
        </main>
        <Toaster />
      </body>
    </html>
  );
}
