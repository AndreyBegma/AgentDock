import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'Work' };

export default function WorkLayout({ children }: { children: ReactNode }) {
  return children;
}
