import { describe, expect, test } from 'bun:test';
import { Button } from '@andrewbehma/glass-ui/button';
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PhoneBackBar, phoneBackBarName } from './phone-back-bar';

const exitButton = (bar: ReactElement<{ children?: ReactNode }>) => {
  const button = Children.toArray(bar.props.children).find(
    (child) => isValidElement(child) && child.type === Button,
  );
  if (!isValidElement<{ onClick: () => void }>(button)) {
    throw new Error('exit Button expected');
  }
  return button;
};

describe('PhoneBackBar (#675)', () => {
  test('Back names its destination and is a 44 px button', () => {
    const html = renderToStaticMarkup(
      <PhoneBackBar label="Board" title="Design" onExit={() => {}} />,
    );
    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Back to Board"');
    expect(html).toContain('>Board</span>');
    expect(html).toContain('Design');
    expect(html).toContain('h-(--size-tap)');
    expect(html).toContain('min-w-(--size-tap)');
  });

  test('phones only, in the thumb zone above the safe area and the keyboard', () => {
    const html = renderToStaticMarkup(<PhoneBackBar onExit={() => {}} />);
    expect(html).toContain('lg:hidden');
    expect(html).toContain('fixed');
    expect(html).toContain('env(safe-area-inset-bottom)');
    expect(html).toContain('var(--keyboard-inset)');
  });

  test('inline placement stays in flow, for a sheet footer', () => {
    const html = renderToStaticMarkup(
      <PhoneBackBar kind="close" placement="inline" onExit={() => {}} />,
    );
    expect(html).not.toContain('fixed');
    expect(html).toContain('lg:hidden');
    expect(html).toContain('aria-label="Close"');
  });

  test('the accessible name: Close, Back, Back to a destination', () => {
    expect(phoneBackBarName('close')).toBe('Close');
    expect(phoneBackBarName('close', 'Done')).toBe('Done');
    expect(phoneBackBarName('back')).toBe('Back');
    expect(phoneBackBarName('back', 'Fleet')).toBe('Back to Fleet');
  });

  test('a click on the exit button calls onExit once', () => {
    let calls = 0;
    const bar = PhoneBackBar({ onExit: () => calls++ });
    exitButton(bar).props.onClick();
    expect(calls).toBe(1);
  });
});
