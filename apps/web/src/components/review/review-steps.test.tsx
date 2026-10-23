import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { peerStep, step } from '../../lib/review/fixtures';
import { REGENERATE_COPY } from '../../lib/review/format';
import { ConfirmGate } from '../confirm/confirm-gate';
import { AddStepForm } from './add-step-form';
import { ReviewStepList } from './review-step-list';

const noop = () => {};

const list = ({
  disabled = false,
  steps = [peerStep(), step('sec', { name: 'Security' }), step('a11y')],
}: {
  disabled?: boolean;
  steps?: ReturnType<typeof step>[];
} = {}) =>
  renderToStaticMarkup(
    <ReviewStepList
      steps={steps}
      disabled={disabled}
      busy={false}
      dragging={null}
      onDragStart={noop}
      onMove={noop}
      onToggle={noop}
      onEdit={noop}
      onRegenerate={noop}
      onDelete={noop}
    />,
  );

describe('ReviewStepList (#890)', () => {
  test('Peer review has no delete action; a skill step has one', () => {
    const html = list();
    expect(html).not.toContain('Delete Peer review');
    expect(html).toContain('aria-label="Delete Security"');
    expect(html).toContain('Built-in');
    expect(html).toContain('Edit instructions');
    expect(html).toContain('Regenerate');
  });

  test('the first step cannot move up, the last cannot move down', () => {
    const html = list();
    const button = (label: string) =>
      html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
    expect(button('Move Peer review up')).toContain('disabled=""');
    expect(button('Move Peer review down')).not.toContain('disabled=""');
    expect(button('Move a11y down')).toContain('disabled=""');
    expect(button('Move Security up')).not.toContain('disabled=""');
  });

  test('every step has a switch that shows whether it is on', () => {
    const html = list({
      steps: [peerStep({ enabled: false }), step('sec', { name: 'Security' })],
    });
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('>Off<');
  });

  test('a member who is not an admin reads: no arrows, delete or Regenerate', () => {
    const html = list({ disabled: true });
    expect(html).not.toContain('Move ');
    expect(html).not.toContain('Delete ');
    expect(html).not.toContain('Regenerate');
    expect(html).toContain('View instructions');
    expect(html).toContain('inert=""');
  });
});

describe('AddStepForm (#890)', () => {
  const form = (over: Partial<Parameters<typeof AddStepForm>[0]> = {}) =>
    renderToStaticMarkup(
      <AddStepForm
        name=""
        skill={null}
        options={[{ value: 'cs-security', label: 'cs-security' }]}
        skillsError={null}
        busy={false}
        error={null}
        onName={noop}
        onSkill={noop}
        onAdd={noop}
        onCancel={noop}
        {...over}
      />,
    );
  const addButton = (html: string) =>
    html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '';

  test('Add is off until a skill and a name are given', () => {
    expect(addButton(form())).toContain('disabled=""');
    expect(addButton(form({ name: 'Security' }))).toContain('disabled=""');
    expect(addButton(form({ skill: 'cs-security' }))).toContain('disabled=""');
    expect(
      addButton(form({ name: 'Security', skill: 'cs-security' })),
    ).not.toContain('disabled=""');
  });

  test('an API refusal and an unreadable skill list show inline', () => {
    const html = form({
      error: 'The project’s runner does not report that skill.',
      skillsError: 'The runner is offline.',
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('does not report that skill');
    expect(html).toContain('The runner is offline.');
  });
});

describe('Regenerate confirmation (#890)', () => {
  const gate = (pending: true | undefined, spy: { calls: string[] }) =>
    ConfirmGate({
      pending,
      copy: () => ({ ...REGENERATE_COPY }),
      onConfirm: () => spy.calls.push('confirm'),
      onCancel: () => spy.calls.push('cancel'),
    });

  test('nothing asks until Regenerate was pressed', () => {
    expect(gate(undefined, { calls: [] })).toBeNull();
  });

  test('the dialog warns that edits are overwritten and runs only on confirm', () => {
    const spy = { calls: [] as string[] };
    const dialog = gate(true, spy);
    expect(dialog?.props.consequence).toContain('Any edits you made are lost');
    expect(dialog?.props.verb).toBe('Regenerate');
    expect(spy.calls).toEqual([]);
    dialog?.props.onOpenChange(false);
    expect(spy.calls).toEqual(['cancel']);
    dialog?.props.onConfirm();
    expect(spy.calls).toEqual(['cancel', 'confirm']);
  });
});
