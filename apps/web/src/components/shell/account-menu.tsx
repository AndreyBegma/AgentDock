'use client';

import { APP_VERSION, type PublicUser } from '@agentdock/shared';
import { Avatar } from '@andrewbehma/glass-ui/avatar';
import { Badge } from '@andrewbehma/glass-ui/badge';
import {
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from '@andrewbehma/glass-ui/menu';
import { LogOut, Shield, Sparkles, User } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  accountMenuLabel,
  versionLabel,
  WHATS_NEW_HREF,
} from '../../lib/whats-new/whats-new';
import { isThemeMode, THEME_LABEL, THEME_MODES, type ThemeMode } from './theme';
import { useWhatsNew } from './whats-new-context';

/** The dot pinned to the avatar and to What's new while a release is unread. */
export function UnreadDot({ className }: { className: string }) {
  return (
    <Badge
      dot
      tone="danger"
      aria-hidden="true"
      className={`size-2 ring-2 ring-surface ${className}`}
      data-testid="whats-new-dot"
    />
  );
}

/**
 * The avatar's menu: account, admin, theme, What's new with the version
 * (C-294) and log out.
 */
export function AccountMenu({
  displayName,
  role,
  theme,
  onThemeChange,
  onLogout,
}: {
  displayName: string;
  role: PublicUser['role'];
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  onLogout: () => void;
}) {
  const router = useRouter();
  const { unread } = useWhatsNew();

  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <button
          type="button"
          className="relative rounded-full"
          aria-label={accountMenuLabel(unread)}
        >
          <Avatar
            size="sm"
            name={displayName}
            className="size-(--size-control)"
          />
          {unread ? <UnreadDot className="absolute top-0 right-0" /> : null}
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>
          {displayName} · {role}
        </MenuLabel>
        <MenuItem onSelect={() => router.push('/account')}>
          <User size={16} aria-hidden="true" />
          Account
        </MenuItem>
        {role === 'admin' ? (
          // C-282: the admin pages left the rail for this entry.
          <MenuItem onSelect={() => router.push('/admin')}>
            <Shield size={16} aria-hidden="true" />
            Admin
          </MenuItem>
        ) : null}
        <MenuItem onSelect={() => router.push(WHATS_NEW_HREF)}>
          <Sparkles size={16} aria-hidden="true" />
          <span className="flex-1">What’s new</span>
          {unread ? <UnreadDot className="shrink-0" /> : null}
          <span className="text-xs tabular-nums text-ink-3">
            {versionLabel(APP_VERSION)}
          </span>
        </MenuItem>
        <MenuSeparator />
        <MenuLabel>Theme</MenuLabel>
        <MenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            if (isThemeMode(value)) onThemeChange(value);
          }}
        >
          {THEME_MODES.map((mode) => (
            <MenuRadioItem key={mode} value={mode}>
              {THEME_LABEL[mode]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem tone="danger" onSelect={onLogout}>
          <LogOut size={16} aria-hidden="true" />
          Log out
        </MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}
