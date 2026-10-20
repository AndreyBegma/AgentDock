'use client';

import { NavTab, NavTabs } from '@andrewbehma/glass-ui/tabs';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { ScrollX } from '../scroll-x/scroll-x';
import { activeEntryId, visibleNav } from './nav';

/**
 * The admin area's own sub-navigation (C-282): the admin pages left the rail
 * for the account menu's Admin entry, so each admin page carries a row of
 * link tabs to its siblings. The row scrolls where it does not fit.
 */
export function AdminNav() {
  const pathname = usePathname();
  const sections = visibleNav('admin', pathname);
  const admin = sections.find((section) => section.id === 'admin');
  if (!admin) return null;
  const activeId = activeEntryId([admin], pathname);
  return (
    <ScrollX className="w-full">
      <NavTabs aria-label="Admin" link={NextLink} className="w-max min-w-full">
        {admin.entries.map((entry) => (
          <NavTab
            key={entry.id}
            href={entry.resolvedHref}
            current={entry.id === activeId}
            className="min-w-fit"
          >
            {entry.label}
          </NavTab>
        ))}
      </NavTabs>
    </ScrollX>
  );
}
