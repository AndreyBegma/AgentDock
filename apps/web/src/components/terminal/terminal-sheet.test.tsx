import { describe, expect, test } from 'bun:test';
import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SendSessionMessage } from '../../lib/session-message/actions';
import { PhoneBackBar } from '../shell/phone-back-bar';
import { terminalSheetFooter } from './terminal-sheet';

const send: SendSessionMessage = () => Promise.reject(new Error('unused'));
const message = { send };

const barOf = (footer: ReactNode) => {
  if (!isValidElement<{ children: ReactNode }>(footer)) {
    throw new Error('footer element expected');
  }
  const bar = Children.toArray(footer.props.children).find(
    (child) => isValidElement(child) && child.type === PhoneBackBar,
  );
  if (!isValidElement<{ onExit: () => void }>(bar)) {
    throw new Error('PhoneBackBar expected');
  }
  return bar;
};

describe('TerminalSheet phone back bar (#679)', () => {
  test('desktop is unchanged: no bar, and no footer without a message line', () => {
    const base = { narrow: false, title: 'slot-1', onClose: () => {} };
    expect(terminalSheetFooter({ ...base, mode: 'read' })).toBeUndefined();
    expect(
      terminalSheetFooter({ ...base, mode: 'write', message }),
    ).toBeUndefined();
    const html = renderToStaticMarkup(
      <>{terminalSheetFooter({ ...base, mode: 'read', message })}</>,
    );
    expect(html).toContain('Message to the session');
    expect(html).not.toContain('data-phone-back-bar');
  });

  test('a phone gets the bar inline in the footer, under the message line', () => {
    const html = renderToStaticMarkup(
      <>
        {terminalSheetFooter({
          narrow: true,
          mode: 'read',
          title: 'slot-1',
          message,
          backTo: 'Fleet',
          onClose: () => {},
        })}
      </>,
    );
    expect(html).toContain('aria-label="Back to Fleet"');
    expect(html).not.toContain('fixed');
    expect(html.indexOf('Message to the session')).toBeLessThan(
      html.indexOf('data-phone-back-bar'),
    );
  });

  test('one tap on the bar closes the sheet; Close without a destination', () => {
    let closed = 0;
    const footer = terminalSheetFooter({
      narrow: true,
      mode: 'write',
      title: 'slot-1',
      onClose: () => closed++,
    });
    expect(renderToStaticMarkup(<>{footer}</>)).toContain('aria-label="Close"');
    barOf(footer).props.onExit();
    expect(closed).toBe(1);
  });
});
