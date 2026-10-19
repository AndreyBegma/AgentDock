import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { question } from '../../lib/planner/fixtures';
import { QuestionStepper } from './question-stepper';

const render = (thumbNav?: boolean) =>
  renderToStaticMarkup(
    <QuestionStepper
      questions={[question(), question({ id: 'q2', title: 'Name' })]}
      thumbNav={thumbNav}
      onSubmit={async () => {}}
    />,
  );

describe('QuestionStepper thumb navigation (#678)', () => {
  test('by default Previous and Next stay in the form, at the small size', () => {
    const html = render();
    expect(html).not.toContain('data-thumb-nav');
    expect(html).not.toContain(' h-(--size-tap) px-4');
    expect(html).not.toContain('pb-16');
  });

  test('on a phone they are pinned above the back bar at the tap size', () => {
    const html = render(true);
    expect(html).toContain('data-thumb-nav');
    expect(html).toContain('var(--keyboard-inset)');
    expect(html.match(/ h-\(--size-tap\) px-4/g)?.length).toBe(2);
    // The form ends clear of the pinned row.
    expect(html).toContain('pb-16');
  });
});
