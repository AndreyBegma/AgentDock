import { describe, expect, test } from 'bun:test';
import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PhoneBackBar, type PhoneBackBarKind } from '../shell/phone-back-bar';
import { FullScreenLayerFrame } from './full-screen-layer';

const barOf = (layer: ReturnType<typeof FullScreenLayerFrame>) => {
  const bar = Children.toArray(
    (layer.props as { children: ReactNode }).children,
  ).find((child) => isValidElement(child) && child.type === PhoneBackBar);
  return isValidElement<{ kind: PhoneBackBarKind; onExit: () => void }>(bar)
    ? bar
    : undefined;
};

describe('FullScreenLayer phone back bar (#675)', () => {
  test('without a handler the layer is unchanged: no bar, no padding', () => {
    const html = renderToStaticMarkup(
      <FullScreenLayerFrame label="Design viewer">body</FullScreenLayerFrame>,
    );
    expect(html).toContain('aria-label="Design viewer"');
    expect(html).not.toContain('data-phone-back-bar');
    expect(html).not.toContain('pb-');
  });

  test('onBack draws Back with its destination and pads the end on a phone', () => {
    const html = renderToStaticMarkup(
      <FullScreenLayerFrame
        label="Design viewer"
        onBack={() => {}}
        bar={{ label: 'Card', title: 'Design' }}
      >
        body
      </FullScreenLayerFrame>,
    );
    expect(html).toContain('data-phone-back-bar');
    expect(html).toContain('aria-label="Back to Card"');
    expect(html).toContain(
      'max-lg:pb-[calc(6rem+env(safe-area-inset-bottom))]',
    );
  });

  test('onClose draws Close, and the bar exits through the handler', () => {
    let closed = 0;
    const layer = FullScreenLayerFrame({
      label: 'New work',
      children: 'body',
      onClose: () => closed++,
    });
    const bar = barOf(layer);
    expect(bar?.props.kind).toBe('close');
    bar?.props.onExit();
    expect(closed).toBe(1);
  });

  test('onBack wins over onClose', () => {
    let backs = 0;
    const layer = FullScreenLayerFrame({
      label: 'Design viewer',
      children: 'body',
      onBack: () => backs++,
      onClose: () => {
        throw new Error('onClose must not run');
      },
    });
    const bar = barOf(layer);
    expect(bar?.props.kind).toBe('back');
    bar?.props.onExit();
    expect(backs).toBe(1);
  });
});
