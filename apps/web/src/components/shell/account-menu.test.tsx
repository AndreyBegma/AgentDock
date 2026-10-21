import { describe, expect, mock, test } from 'bun:test';
import { MenuItem } from '@andrewbehma/glass-ui/menu';
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';

const pushed: string[] = [];
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: (href: string) => pushed.push(href) }),
}));
mock.module('./whats-new-context', () => ({
  useWhatsNew: () => ({ unread: false, markSeen: () => {} }),
}));

const { AccountMenu } = await import('./account-menu');

type Props = {
  children?: ReactNode;
  asChild?: boolean;
  onSelect?: () => void;
  href?: string;
  target?: string;
  rel?: string;
  'aria-label'?: string;
};

/** Every element in the tree the menu returns, depth first. */
const elements = (node: ReactNode): ReactElement<Props>[] =>
  Children.toArray(node).flatMap((child) =>
    isValidElement<Props>(child)
      ? [child, ...elements(child.props.children)]
      : [],
  );

const text = (node: ReactNode): string =>
  Children.toArray(node)
    .map((child) =>
      typeof child === 'string'
        ? child
        : isValidElement<Props>(child)
          ? text(child.props.children)
          : '',
    )
    .join('');

// AccountMenu calls only the mocked hooks, so its element tree is read
// without rendering the closed menu's portal.
const menu = () =>
  elements(
    AccountMenu({
      displayName: 'Ada',
      role: 'operator',
      theme: 'system',
      onThemeChange: () => {},
      onLogout: () => {},
    }),
  );

const items = () => menu().filter((each) => each.type === MenuItem);

describe('AccountMenu (#743)', () => {
  test('About routes to /account/about', () => {
    const about = items().find((each) => text(each.props.children) === 'About');
    if (!about?.props.onSelect) throw new Error('About item expected');
    about.props.onSelect();
    expect(pushed.at(-1)).toBe('/account/about');
  });

  test('the present contacts are new-tab anchors with accessible names', () => {
    const anchors = items()
      .filter((each) => each.props.asChild)
      .map((each) => Children.only(each.props.children))
      .filter((each): each is ReactElement<Props> => isValidElement(each));
    expect(anchors.map((each) => each.type)).toEqual(['a', 'a', 'a']);
    expect(anchors.map((each) => each.props.href)).toEqual([
      'https://github.com/AndreyBegma',
      'https://t.me/abegma',
      'mailto:abegma137@gmail.com',
    ]);
    expect(anchors.map((each) => each.props['aria-label'])).toEqual([
      'GitHub: AndreyBegma',
      'Telegram: @abegma',
      'Email: abegma137@gmail.com',
    ]);
    for (const anchor of anchors) {
      expect(anchor.props.target).toBe('_blank');
      expect(anchor.props.rel).toBe('noopener noreferrer');
    }
  });

  test('LinkedIn, without a link, is not in the menu', () => {
    expect(
      items().some((each) => text(each.props.children) === 'LinkedIn'),
    ).toBe(false);
  });

  test('About and the contacts sit between Theme and Log out', () => {
    const labels = items().map((each) => text(each.props.children));
    const about = labels.indexOf('About');
    expect(
      labels.findIndex((label) => label.startsWith('What’s new')),
    ).toBeLessThan(about);
    expect(labels.slice(about, about + 4)).toEqual([
      'About',
      'GitHub',
      'Telegram',
      'Email',
    ]);
    expect(labels.at(-1)).toBe('Log out');
  });
});
