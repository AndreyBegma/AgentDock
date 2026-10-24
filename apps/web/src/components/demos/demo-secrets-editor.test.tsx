import { describe, expect, test } from 'bun:test';
import type { DemoSecretView } from '@nautelle/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { DemoRunnerStatus } from './demo-runner-status';
import { DemoSecretForm, DemoSecretsList } from './demo-secrets-editor';

const secrets: DemoSecretView[] = [
  {
    name: 'DEMO_ADMIN_PASSWORD',
    updatedAt: '2026-10-24T10:00:00.000Z',
    updatedByName: 'Ada',
  },
];

describe('Demo env secrets form (C-371)', () => {
  test('the list shows names and never a value', () => {
    const html = renderToStaticMarkup(
      <DemoSecretsList secrets={secrets} isAdmin />,
    );
    expect(html).toContain('DEMO_ADMIN_PASSWORD');
    expect(html).toContain('Value hidden');
    expect(html).not.toContain('<input');
    expect(html).toContain('Replace');
    expect(html).toContain('Delete');
  });

  test('the value field is an empty, masked, write-only password input', () => {
    const html = renderToStaticMarkup(
      <DemoSecretForm
        name="DEMO_ADMIN_PASSWORD"
        value=""
        busy={false}
        replacing
        onNameChange={() => {}}
        onValueChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    const value = /<input[^>]*id="demo-secret-value"[^>]*>/.exec(html)?.[0];
    expect(value).toContain('type="password"');
    expect(value).toContain('autoComplete="new-password"');
    expect(value).toContain('value=""');
    expect(html).toContain('cannot be shown again');
  });

  test('a viewer sees names without Replace or Delete', () => {
    const html = renderToStaticMarkup(
      <DemoSecretsList secrets={secrets} isAdmin={false} />,
    );
    expect(html).toContain('DEMO_ADMIN_PASSWORD');
    expect(html).not.toContain('Replace');
    expect(html).not.toContain('Delete');
  });

  test('a name that is not an environment variable name is refused', () => {
    const html = renderToStaticMarkup(
      <DemoSecretForm
        name="demo-pass"
        value="x"
        busy={false}
        replacing={false}
        onNameChange={() => {}}
        onValueChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('environment variable name');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Add secret/);
  });
});

describe('DemoFlow runner status (C-371)', () => {
  test('a ready runner shows its version and no warning', () => {
    const html = renderToStaticMarkup(
      <DemoRunnerStatus
        runner={{
          supported: true,
          demoflow: { version: '0.4.0', ready: true, reason: null },
        }}
      />,
    );
    expect(html).toContain('0.4.0');
    expect(html).toContain('Ready');
    expect(html).not.toContain('Recording is not available');
  });

  test('a runner that is not ready says why and what to do', () => {
    const html = renderToStaticMarkup(
      <DemoRunnerStatus
        runner={{
          supported: true,
          demoflow: {
            version: '0.4.0',
            ready: false,
            reason: 'Node 18 is too old',
          },
        }}
      />,
    );
    expect(html).toContain('Not ready');
    expect(html).toContain('Node 18 is too old');
    expect(html).toContain('demoflow.config.json');
  });

  test('an old runner is told to update', () => {
    const html = renderToStaticMarkup(
      <DemoRunnerStatus runner={{ supported: false, demoflow: null }} />,
    );
    expect(html).toContain('Update the runner');
  });
});
