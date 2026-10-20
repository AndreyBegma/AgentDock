import { describe, expect, test } from 'bun:test';
import type { ScheduleView } from '@nautelle/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnerNotice } from './schedule-dialog';

const schedule = { id: 's1', createdById: 'admin' } as ScheduleView;

describe('OwnerNotice (D-09)', () => {
  test("editing someone else's schedule says it will run with your authority", () => {
    const html = renderToStaticMarkup(
      <OwnerNotice schedule={schedule} userId="operator" />,
    );
    expect(html).toContain('the schedule will run with your authority');
  });

  test('says nothing for your own schedule or a new one', () => {
    expect(
      renderToStaticMarkup(<OwnerNotice schedule={schedule} userId="admin" />),
    ).toBe('');
    expect(
      renderToStaticMarkup(<OwnerNotice schedule={null} userId="admin" />),
    ).toBe('');
  });
});
