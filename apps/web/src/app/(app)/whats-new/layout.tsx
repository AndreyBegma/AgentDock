import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'What’s new' };

export default function WhatsNewLayout({ children }: { children: ReactNode }) {
  return children;
}
