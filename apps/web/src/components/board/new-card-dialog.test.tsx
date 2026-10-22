import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FullScreenLayerFrame } from '../design/full-screen-layer';
import {
  NewWorkScreenBody,
  newWorkLayer,
  PrefilledBriefNotice,
} from './new-card-dialog';

const render = (open: boolean, drafted: boolean) =>
  renderToStaticMarkup(
    <FullScreenLayerFrame
      {...newWorkLayer({ open, drafted, onClose: () => {} })}
    >
      <NewWorkScreenBody drafted={drafted}>step</NewWorkScreenBody>
    </FullScreenLayerFrame>,
  );

describe('New work on a phone (#678)', () => {
  test('the bar closes it in one tap: Close, titled New work', () => {
    const html = render(true, false);
    expect(html).toContain('aria-label="New work"');
    expect(html).toContain('data-phone-back-bar');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('>New work</b>');
    expect(html).not.toContain('Draft saved');
    expect(html).not.toContain('hidden=""');
  });

  test('a started intake says its draft is saved', () => {
    const html = render(true, true);
    expect(html).toContain('Draft saved');
    expect(html).toContain('Close this to keep it as a draft.');
  });

  test('closed, the layer stays mounted but hidden, keeping what was typed', () => {
    const html = render(false, false);
    expect(html).toContain('hidden=""');
    expect(html).toContain('step');
  });

  test('the bar calls the close handler', () => {
    let closed = 0;
    const props = newWorkLayer({
      open: true,
      drafted: false,
      onClose: () => {
        closed += 1;
      },
    });
    props.onClose();
    expect(closed).toBe(1);
  });
});

describe('a brief prefilled by a link (L-45)', () => {
  test('the notice asks the person to check it', () => {
    expect(renderToStaticMarkup(<PrefilledBriefNotice />)).toContain(
      'Pre-filled from a link — check before sending.',
    );
  });
});
