import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'Usage' };

export default function UsageLayout({ children }: { children: ReactNode }) {
  return children;
}
